import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { MemberCliRegistry } from './cli-tools.mjs';
import { ExecutionCatalog, cliRuntimePaths, executionConfiguration, suggestedExecutionSources } from './execution-catalog.mjs';
import { LanError, reject } from '../core/errors.js';
import * as v from '../core/validation.js';

const modules = new Set(['@local/dsh-multi-user-service/cli-tools', '@sunbigfly/dsh-multi-user-service/cli-tools']);
const fields = ['id','label','enabled','command','args','readOnlyPaths','environment','credentials'];
const revision = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
function toolsOf(tools) {
  if (!Array.isArray(tools) || tools.length > 128 || JSON.stringify(tools).length > 128 * 1024) reject('INVALID_INPUT','CLI 清单过大。');
  const seen = new Set();
  return tools.map(tool => {
    v.object(tool, fields, ['id','command']);
    const id = v.text(tool.id,'CLI command',64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || seen.has(id)) reject('INVALID_INPUT','命令名称必须唯一，且只包含字母、数字、点、下划线或连字符。');
    seen.add(id);
    const command=v.text(tool.command,'executable path',4096);
    if (!isAbsolute(command)) reject('INVALID_INPUT','可执行程序须填写服务器上的绝对路径。');
    const strings=(value,name)=>{
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length>128 || value.some(item=>typeof item!=='string'||item.length>4096||item.includes('\0'))) reject('INVALID_INPUT',`请检查${name}。`);
      return [...value];
    };
    const dictionary=(value,name)=>{
      if (value===undefined) return {};
      if (!value || Array.isArray(value) || typeof value!=='object' || Object.keys(value).length>128) reject('INVALID_INPUT',`请检查${name}。`);
      for (const [key,item] of Object.entries(value)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item!=='string' || item.length>8192 || item.includes('\0') || /^(?:HOME|PATH|PWD|DSH_HOME|TMPDIR|TMP|TEMP|XDG_.*)$/.test(key)) reject('INVALID_INPUT',`请检查${name}，系统目录变量不能覆盖。`);
      return {...value};
    };
    return {id,label:tool.label===undefined ? id : v.text(tool.label,'CLI display name',120),enabled:tool.enabled===undefined ? true : v.bool(tool.enabled,'CLI enabled'),command,args:strings(tool.args,'启动参数'),readOnlyPaths:strings(tool.readOnlyPaths,'依赖目录'),environment:dictionary(tool.environment,'环境变量'),credentials:dictionary(tool.credentials,'凭据引用')};
  });
}

/** Only the bundled CLI entry is editable. The native profile editor owns disk
 * locking, validation, persistence and Loader reconciliation. Credential values
 * are never resolved by this administration interface. */
export class CliManagement {
  constructor({core,editor,onChanged=async()=>{},sessionBrowser=()=>false}) { Object.assign(this,{core,editor,onChanged,sessionBrowser}); }
  entry() {
    const entries=this.editor?.entries().filter(entry=>entry.options.id==='member-cli-tools'&&modules.has(entry.options.name));
    if (entries?.length!==1) reject('CLI_UNAVAILABLE','成员 CLI 工具组件未启用，或当前配置不可编辑。',503);
    return entries[0];
  }
  snapshot() {
    const entry=this.entry(),config=entry.options.config ?? {};
    return { revision:revision(config),tools:toolsOf(config.tools ?? []),executionTools:executionConfiguration(config.executionTools ?? {}) };
  }
  async execute(request,caller) {
    const result=await this.core.runAdministratorOperation(caller,async()=>{
      v.object(request,['action','operation','expectedRevision','tools','executionTools','sources','target'],['action','operation']);
      if (request.action!=='admin.cliTools') reject('INVALID_INPUT','CLI 操作无效。');
      if (request.operation==='read') {
        if (Object.keys(request).some(key=>!['action','operation'].includes(key))) reject('INVALID_INPUT','CLI 读取参数无效。');
        return { ...this.snapshot(), suggestedSources: await suggestedExecutionSources() };
      }
      if (request.operation==='scan') {
        if (Object.keys(request).some(key=>!['action','operation','sources'].includes(key))) reject('INVALID_INPUT','工具扫描参数无效。');
        const catalog=new ExecutionCatalog(this.snapshot().executionTools,{sessionBrowser:this.sessionBrowser});
        const sources=request.sources ?? catalog.configuration.sources;
        return catalog.publicInventory(await catalog.scan(sources));
      }
      if (request.operation==='inspect') {
        if (Object.keys(request).some(key=>!['action','operation','target'].includes(key))) reject('INVALID_INPUT','工具识别参数无效。');
        const target=v.text(request.target,'工具名称或路径',4096).trim();
        if (!isAbsolute(target) && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(target)) reject('INVALID_INPUT','请输入一个命令名称或绝对路径；参数请在识别后单独填写。');
        const candidates=isAbsolute(target) ? [target] : [...new Set((process.env.PATH ?? '').split(delimiter).filter(isAbsolute))].map(root=>join(root,target));
        let command;
        for (const path of candidates) {
          try { await access(path,constants.X_OK); if ((await stat(path)).isFile()) { command=await realpath(path); break; } } catch {}
        }
        if (!command) reject('CLI_NOT_FOUND','未找到这个可执行程序。请检查服务器上的命令名称或绝对路径。',404);
        try {
          const label=basename(target).slice(0,120),id=label.replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^[^A-Za-z0-9]+/,'').slice(0,64)||'cli-tool';
          const tool={id,label,command,args:[],readOnlyPaths:await cliRuntimePaths(command),environment:{},credentials:{},enabled:true};
          new MemberCliRegistry({tools:[tool]});
          return {tool};
        } catch { reject('CLI_INSPECTION_FAILED','程序已找到，但无法推断安全的运行依赖。可手动配置程序与所需只读路径。',422); }
      }
      if (request.operation!=='save' || !/^[a-f0-9]{64}$/.test(request.expectedRevision ?? '')) reject('INVALID_INPUT','CLI 保存参数无效。');
      if (Object.hasOwn(request,'sources') || Object.hasOwn(request,'target')) reject('INVALID_INPUT','保存时请使用通用工具配置。');
      const entry=this.entry(),current=this.snapshot(),tools=Object.hasOwn(request,'tools') ? toolsOf(request.tools) : current.tools;
      const executionTools=Object.hasOwn(request,'executionTools') ? executionConfiguration(request.executionTools) : current.executionTools;
      if (Buffer.byteLength(JSON.stringify({format:'dsh-execution-tools',version:1,tools,executionTools})) > 128 * 1024) reject('CLI_CONFIG_TOO_LARGE','通用工具配置不能超过 128 KiB。',413);
      if (request.expectedRevision!==current.revision) reject('CLI_CONFLICT','CLI 配置已被其他人修改，请重新载入后再保存。',409);
      try { new MemberCliRegistry({tools}); }
      catch { reject('CLI_INVALID_CONFIG','可执行程序或依赖目录不可用。请检查服务器路径，并避开个人目录、凭据目录和过宽的目录范围。',422); }
      await new ExecutionCatalog(executionTools,{sessionBrowser:this.sessionBrowser}).validateGrants();
      if (JSON.stringify(tools)===JSON.stringify(current.tools) && JSON.stringify(executionTools)===JSON.stringify(current.executionTools)) return {...current,changed:false};
      try {
        await this.editor.edit(entry,raw=>{
          if (revision(raw)!==request.expectedRevision) reject('CLI_CONFLICT','CLI 配置已更新，请重新载入后再保存。',409);
          return {...raw,tools,...(Object.hasOwn(request,'executionTools') ? {executionTools} : {})};
        });
      } catch(error) {
        if (error instanceof LanError) throw error;
        reject('CLI_SAVE_FAILED','CLI 配置保存失败，草稿已保留。请重新载入后重试。',503);
      }
      return {...this.snapshot(),changed:true};
    });
    if (result.changed) {
      try { await this.onChanged(); }
      catch { reject('CLI_RESET_FAILED','CLI 配置已保存，但执行资源未完全重置。请重新载入配置并关闭旧会话后使用。',503); }
    }
    return result;
  }
}
