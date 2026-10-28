window.__ModuleLoader__.load({
  id: '@sunbigfly/dsh-multi-user-service',
  factory(require) {
    const React = require('react');
    const { Menu, Modal, Switch, Tooltip, IconInfoOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular,
      IconUserOutlineRegular, IconUsersOutlineRegular, IconSlidersTwoOutlineRegular, IconFolderOpenOutlineRegular,
      IconDatabaseOutlineRegular, IconShareOutlineRegular, IconPersonalizationOutlineRegular, IconGaugeOutlineRegular,
      IconSparkleRegular, IconCheckCircleOutlineRegular, IconShieldOutlineRegular, IconSkillOutlineRegular,
      IconApiOutlineRegular, IconAgentPresetOutlineRegular, IconPluginPinwheelOutlineRegular, IconNewChatOutlineRegular,
      FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const NS = 'lan-workspace';
    // The Desktop app renders this page from its own `dsh-app://` origin, where a
    // relative request never reaches the Host. DSH's own client talks to the Host
    // through `__DSH_TRANSPORT__.fetch`; use it when present, and otherwise fall
    // back to the Host's real origin carried by `streamBaseUrl`.
    const transport = globalThis.__DSH_TRANSPORT__;
    const transportFetch = typeof transport?.fetch === 'function' ? transport.fetch.bind(transport) : null;
    const hostOrigin = (() => {
      try {
        const base = transport?.streamBaseUrl;
        return typeof base === 'string' && base !== '' ? new URL(base).origin : null;
      } catch { return null; }
    })();
    const ENDPOINT = window.__DSH_LAN_MEMBER__ ? '/lan/api/lan-workspace' : '/api/lan-workspace';
    // The Desktop window runs on `dsh-app://`, an origin the Host rejects outright.
    // The plugin answers the same facade on its own ingress, so that window calls
    // it cross-origin with its bearer session instead of the fenced `/api` route.
    const port = (() => {
      try { return hostOrigin ? new URL(hostOrigin).port : ''; } catch { return ''; }
    })();
    const desktopEndpoint = port === '' ? null : `http://localhost:${port}/lan/owner-api`;
    const browserHint = port === '' ? null : `http://localhost:${port}/lan/`;
    const target = desktopEndpoint ?? (hostOrigin ? `${hostOrigin}${ENDPOINT}` : ENDPOINT);
    const send = init => (transportFetch ? transportFetch(ENDPOINT, init) : fetch(target, init));
    // A desktop window cannot receive the owner cookie, so its bearer session is
    // stored for the Desktop facade and revalidated on every start. Member
    // pages use HttpOnly cookies and never enter this storage path.
    const DESKTOP_SESSION_KEY = 'lan-workspace.desktop-session';
    const desktopWindow = !window.__DSH_LAN_MEMBER__ && desktopEndpoint !== null;
    const readDesktopSession = () => {
      if (!desktopWindow) return null;
      try {
        const raw = window.localStorage?.getItem(DESKTOP_SESSION_KEY);
        if (typeof raw !== 'string') return null;
        const stored = JSON.parse(raw);
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(stored?.token ?? '') || !/^[A-Za-z0-9_-]{32,256}$/.test(stored?.csrf ?? '')) return null;
        return stored;
      } catch { return null; }
    };
    const writeDesktopSession = value => {
      if (!desktopWindow) return;
      try {
        if (value?.token && value?.csrf) window.localStorage?.setItem(DESKTOP_SESSION_KEY, JSON.stringify({ token: value.token, csrf: value.csrf }));
        else window.localStorage?.removeItem(DESKTOP_SESSION_KEY);
      } catch { /* an unavailable storage only costs one sign-in */ }
    };
    const clearDesktopSession = () => writeDesktopSession(null);
    const PUBLIC_ACTIONS = new Set(['status', 'auth.restore', 'bootstrap', 'login', 'redeem', 'owner.recoverAdministrator']);
    const READ_ACTIONS = new Set(['status', 'me', 'snapshot']);
    // A partial reply replaces current account/grant data. Reuse only catalog
    // metadata for the same identity, filtered by its newly returned grants.
    function mergeWorkspaceSnapshot(previous, next) {
      if (previous?.user?.id !== next.user.id || previous.user.role !== next.user.role) return next;
      const result = { ...next };
      if (next.admin && previous.admin) {
        result.admin = { ...next.admin };
        for (const key of ['toolCatalog', 'skillCatalog', 'skillCatalogComplete', 'agentPresetCatalog', 'permissionPresetCatalog', 'pluginCatalog', 'mcpCatalog', 'unAttributedTools']) {
          if (result.admin[key] === undefined && previous.admin[key] !== undefined) result.admin[key] = previous.admin[key];
        }
      }
      if (next.preferences && !next.preferences.catalog && previous.preferences?.catalog) {
        const catalog = Object.fromEntries(Object.entries(previous.preferences.catalog).map(([field, rows]) => [field,
          rows.filter(row => next.preferences.granted[field] === null || next.preferences.granted[field]?.includes(row.id)),
        ]));
        result.preferences = { ...next.preferences, catalog, skillCatalogComplete: previous.preferences.skillCatalogComplete };
      }
      return result;
    }
    const messages = {
      zh: {
        searchModels: '搜索提供方或模型', effortLevels: '个等级', selectedVariants: '已选 / 可选等级', searchResources: '搜索资源名称或说明', pageSize: '每页模型数', previousPage: '上一页', nextPage: '下一页', modelsCount: '个模型', variantsCount: '个组合', noMatches: '没有匹配项。', allShared: '默认共享全部兼容资源', selectivelyShared: '已自定义共享范围', sharedResource: '已共享', notSharedResource: '未共享', selectPage: '全选本页', clearPage: '清空本页', description: '说明', noDescription: '暂无说明', expandDescription: '展开', collapseDescription: '收起', saveSharing: '保存共享范围', reloadSharing: '重新加载并放弃草稿', sharingNotice: '修改共享范围会停止当前项目；文件和历史保留，重新打开后生效。', sharingFailed: '保存失败，草稿已保留。请明确重新加载后再修改，避免覆盖较新的共享策略。',
        modelDefault: '模型默认（不指定思考等级）',
        title: '多用户服务', subtitle: '管理成员账号、权限与服务器资源', currentAccount: '当前登录账号',
        workspaceInfo: '使用说明', infoClose: '关闭说明', accessHelp: '入口', accessNote: '成员入口与本页是同一服务。不同主机名用于隔开所有者权限，需用工作区账号登录。', enterMember: '进入成员工作区 ↗', checkIsolation: '检查隔离环境', checkingIsolation: '正在检查…', isolationPassed: '检查通过', isolationFailed: '检查未通过', isolationRestart: '请停用并重新启用本插件后重试。', isolationRetry: '检查系统环境后重试。',
        discardEdit: '放弃未保存的账号修改？', discardChanges: '放弃修改', keepEditing: '继续编辑',
        userHome: '个人工作目录', homeAlias: '家目录', homeReady: '已自动分配', homePending: '正在等待系统分配', homeUnavailable: '暂时无法确认目录状态，请刷新或联系管理员。', homeAutomatic: '系统为每个账号自动分配目录，无需模型授权。项目只挂载各自子目录。', homeDirectory: '用户主目录', homeRoot: '统一根目录（Linux 绝对路径）', homeCurrentRoot: '当前根目录', homeDefaultRoot: '启动默认根目录', homeRootNote: '使用服务器上的绝对路径。改根只影响新分配用户，已有目录和项目不迁移。', homeRootSave: '保存主目录', homeRootReload: '重新读取并放弃草稿', homeRootFailed: '保存未完成或配置已更新，草稿已保留。请明确重新读取后再修改，避免覆盖较新的目录配置。', homeRootUnknown: '尚未取得目录配置，请刷新。', legacyReservations: '兼容：项目元数据预留',
        accountsTab: '账号', modelsTab: '模型', sharingTab: '共享环境', advancedTab: '高级', searchAccounts: '搜索账号或显示名', newAccount: '新建账号', inviteAccount: '邀请成员', editAccount: '编辑', closePanel: '关闭', accountRole: '角色', accountStatus: '状态', accountVariants: '授权组合', accountActions: '操作', accountCount: '账号', modelCount: '已配置模型', sharedCount: '共享资源', boundaryDetails: '权限边界说明', runtimeReadyBadge: '隔离运行就绪', runtimePendingBadge: '隔离运行待检查', runtimeUnknownBadge: '隔离状态未知', advancedNote: '可选自定义目录，供核对已发布的资源 ID。', dangerZone: '密码与登录安全', accountsNote: '管理工作区登录与模型访问权限。', noAccountMatches: '没有找到匹配的账号。',
        boundary: '所有者管理入口 · 成员使用独立入口', ownerBoundaryShort: '此地址仅供所有者管理，不要分享给成员。',
        memberEntry: '独立成员入口', memberEntryNote: '请打开服务端提供的不同主机名入口，并使用工作区账号独立登录。不会携带此页的所有者授权或插件登录凭据；真实对话和 DSH 原生终端均在成员入口中操作。', memberEntryMissing: '尚未取得有效的独立成员地址。地址必须使用不同主机名；请刷新服务状态或检查服务端配置，不要把当前所有者地址分享给成员。', runtimeStatus: '隔离运行检查', runtimeReady: '执行能力由 DSH 提供；每次操作仍校验账号和会话权限。', runtimePending: '首次打开项目时检查；检查失败不会在宿主执行。', runtimeUnknown: '状态暂不可用，请刷新。',
        ownerOnly: '此入口仍由个人 DSH 的所有者连接承载，不能发给成员使用。插件登录不改变宿主权限；现有会话保持不变。',
        metadataOnly: '本页管理账号与模型授权，不会改变个人 DSH 会话。成员项目默认跟随兼容的 DSH 启动环境；可选自定义覆盖请在独立成员入口以管理员账号管理。',
        workspace: '工作区', usage: '用量广场', admin: '管理', refresh: '刷新', loading: '正在加载…', pending: '正在提交…',
        login: '登录', redeem: '接受邀请', bootstrap: '创建首位管理员', logout: '退出',
        username: '用户名', displayName: '显示名', password: '密码', longPassword: '长密码（至少 16 个字符）',
        inviteToken: '邀请令牌', setupNote: '仅首次初始化使用。此操作必须由当前所有者明确提交，不会自动创建管理员。',
        setupConsent: '我确认以当前 DSH 所有者连接初始化首位管理员', invitationOnly: '不开放公开注册；新成员需要管理员邀请。',
        rememberLogin: '保持登录并记住用户名', memoryOnly: '保持登录通过 HttpOnly Cookie 恢复，可随时退出撤销。这里只保存用户名；密码交给浏览器密码管理器，需由你选择保存，页面不会将密码或令牌写入本地存储。',
        retry: '重试', unknown: '未知', requestFailed: '请求失败，请检查本机服务后重试。', invalidResponse: '服务返回了无法识别的响应。',
        expired: '登录已失效，请重新登录。', timeout: '请求超时，请重试。', csrfMissing: '缺少会话防伪凭据，请重新登录。',
        signedIn: '已登录', memberRole: '成员', adminRole: '管理员', noSnapshot: '尚未取得账号状态，请刷新重试。',
        projects: '我的项目预留', noProjects: '还没有项目预留。它仅保存项目元数据，不会启动会话或创建宿主执行环境。',
        newProject: '新建项目预留', projectTitle: '项目名称', route: '模型与思考等级', chooseRoute: '选择已授权模型与思考等级', noRoutes: '暂无可用的模型与思考等级，请联系管理员授权。',
        reserve: '创建预留', reservation: '本页仅展示项目预留', reservationNote: '此所有者 API 仅保存项目预留，不会启动真实会话，也不绑定个人 DSH 会话。请在独立成员入口创建或打开项目，使用受控对话与隔离终端。',
        selectProject: '选择左侧项目，查看预留详情与隔离执行状态。', rename: '保存名称', projectId: '项目 ID', routeUnavailable: '原路由当前不可用',
        terminal: '项目终端', terminalUnavailable: '请使用独立成员入口打开终端', terminalNote: '从成员入口使用 DSH 原生终端。执行权限和安全边界遵循 DSH 当前配置。',
        isolationCode: 'ISOLATION_UNAVAILABLE', created: '已创建项目预留。', saved: '已保存。',
        accountConflict: '该账号已在其他位置更新。当前草稿已保留，重新加载后再编辑，避免覆盖新的授权或状态。', reloadAccount: '放弃草稿并加载最新账号',
        changePassword: '修改登录密码', currentPassword: '原密码', confirmPassword: '确认新密码', passwordChangeNote: '修改后将退出该账号的所有登录，并停止当前执行。请使用新密码重新登录。', passwordMismatch: '两次输入的新密码不一致。', currentPasswordInvalid: '原密码不正确，请重新输入。', passwordUnchanged: '新密码需要与原密码不同。', passwordChanged: '密码已修改，请使用新密码登录。', passwordRateLimit: '尝试过于频繁，请稍后重试。',
        invitationHistory: '邀请记录', invitePending: '待使用', inviteUsed: '已使用', inviteExpired: '已过期', inviteRevoked: '已撤销', revokeInvite: '撤销', reissueInvite: '重新签发', invitationEmpty: '还没有邀请记录。', inviteLink: '邀请链接', copyInviteLink: '复制邀请链接', linkCopied: '已复制', linkSelectCopy: '请复制已选中的链接', invitationHistoryNote: '邀请仅可使用一次，24 小时有效。重新签发会作废旧链接，已加入的成员不受影响。', inviteConflict: '邀请状态已改变，请刷新后重试。',
        accountRole: '账号角色', roleNote: '管理员可管理全部成员、授权与共享设置。交接时先将接任者设为管理员，再调整原管理员；角色变更后需重新登录。', lastAdmin: '请保留至少一位启用的管理员，再进行交接或禁用。', identityChanged: '账号身份已更新，请重新登录。', 'owner.recoverAdministrator': '恢复管理员', recoveryNote: '此操作仅在已通过 DSH 原生授权的宿主网页可用。输入现有管理员用户名并设置新密码，将撤销该账号的全部旧登录。', recoveryConsent: '确认重置此管理员密码并撤销全部旧登录', administratorRecovered: '管理员已恢复，请使用新密码登录。',
        copyGrants: '沿用成员授权（可选）', chooseGrantSource: '选择一个成员作为授权模板', applyGrantCopy: '应用授权', grantsCopied: '已应用此成员的授权，保存后生效。', grantCopyNote: '仅沿用模型、能力和目录权限。', findOtherMember: '查找其他成员', effectiveAccess: '查看已保存的生效范围', effectiveAccessNote: '以下是已保存的账号授权与个人选择，草稿保存后才生效。实际调用还取决于 DSH 当前启用的资源和功能约束。', grantedColumn: '管理员授予', selectedColumn: '个人选择', effectiveColumn: '账号生效', scopeAll: '沿用全部', scopeNone: '无', scopeEnabled: '开启', scopeDisabled: '关闭', effectiveModels: '当前可用模型', accountDisabledNote: '账号已禁用，所有使用权限均不生效。',
        grantLimited: '受管理员授权限制', personallyLimited: '个人已关闭或缩小范围', accountUnavailable: '账号已禁用', memberPickerHint: '选择成员或输入名称搜索', memberTooMany: '匹配成员较多，请继续输入名称以缩小范围。',
        allTime: '全部 · 服务端聚合', usageNote: '仅公开显示名与聚合用量；不展示其他成员的项目、提示词、文件或路由凭据。',
        usageUnknown: '部分用量未知；未知值不计作 0。', usageEmpty: '尚无服务端用量记录；这不表示用量为 0。',
        calls: '调用数', inputTokens: '输入 tokens', outputTokens: '输出 tokens', totalTokens: '总 tokens', unknownCalls: '未知用量调用数',
        accounts: '账号与邀请', createUser: '创建成员账号', createInvite: '生成一次性邀请', inviteOnce: '邀请令牌仅在本次响应中展示，请安全转交。', expiresAt: '有效期至',
        accountSetupProgress: '创建账号进度', accountSetupInfo: '账号信息', accountSetupPermissions: '权限设置', accountSetupInfoNote: '填写用户名、显示名和登录密码。', accountSetupPermissionsNote: '设置此账号可使用的模型、功能和目录，确认后创建。', accountSetupNext: '下一步', accountSetupBack: '上一步',
        inviteSetupProgress: '生成邀请进度', inviteSetupInfo: '邀请信息', inviteSetupInfoNote: '可填写成员显示名；成员接受邀请时自行设置账号和密码。', inviteSetupPermissionsNote: '设置接受邀请后可使用的模型、功能和目录。', inviteReady: '邀请已生成', accountSetupDone: '完成',
        optionalName: '显示名（可选）', routeAllowlist: '允许的模型与思考等级', defaultRoute: '默认模型与思考等级', noDefault: '暂不设置默认模型',
        editUser: '成员授权与状态', selectUser: '选择账号', disabled: '禁用账号', active: '启用', disabledState: '已禁用',
        accountNote: '禁用或重置密码会撤销该账号的全部登录会话；最后一位有效管理员不可禁用。',
        agentPresetAccess: 'Agent 预设授权', inheritAgentPresets: '继承宿主全部 Agent 预设', customAgentPresets: '自定义 Agent 预设', agentPresetsNote: '仅允许所选预设；自定义列表留空则无法启动 Agent。新会话默认选择获准预设，不修改宿主默认设置。',
        permissionPresetAccess: '权限预设授权', inheritPermissionPresets: '继承宿主全部权限预设', customPermissionPresets: '自定义权限预设', permissionPresetsNote: '执行预设仅作用于本人及授权共享目录；完全访问也不能越过此边界。自定义列表留空则无法启动会话。',
        pluginAccess: '工具插件授权', inheritPlugins: '继承宿主全部工具插件', customPlugins: '自定义工具插件', pluginsNote: '按工具实际所属的宿主插件授权，并与工具名单、功能开关同时生效。自定义列表留空则禁用所有插件工具，不改变服务器安装或全局配置。', pluginDiscoveryIncomplete: '部分工具来源暂不可识别，自定义授权下会拒绝这些工具。',
        mcpAccess: 'MCP 服务器授权', inheritMcp: '继承宿主已配置的 MCP 服务器', customMcp: '自定义 MCP 服务器', mcpNote: '工具调用和资源读取都受服务器名单限制。自定义列表留空则禁用 MCP；连接和凭据始终由宿主管理。', noMcpServers: '当前宿主没有已注册的 MCP 服务器。',
        nativeSharingNote: '成员默认继承宿主现有能力。请在账号管理中逐用户设置可用的工具插件、MCP、Skills、模型和访问范围。以下数量来自当前原生注册目录。',
        sharedDirectories: '共享目录', sharedDirectoriesNote: '授权成员可访问的共享目录，默认只读；文件工具、命令与脚本均受此权限限制。关闭文件功能后这些授权不生效。', directoryPath: '服务器目录路径', directoryMode: '访问权限', directoryReadOnly: '只读', directoryReadWrite: '读写', addDirectory: '添加目录', removeDirectory: '移除目录',
        saveAccess: '保存账号授权', resetPassword: '重置密码', resetConsent: '我确认撤销该账号现有登录并设置新密码',
        modelAccess: '模型授权', inheritModels: '继承宿主全部模型', customModels: '自定义授权', inheritModelsNote: '跟随宿主模型和默认选择，自动包含以后新增的模型。', customModelsNote: '仅允许下方勾选的模型与思考等级；留空则禁用模型。',
        skillAccess: 'Skills 授权', inheritSkills: '继承宿主全部 Skills', customSkills: '自定义 Skills', skillsNote: '自定义列表留空则禁用 Skills；目录展示与内容读取遵循同一授权。', skillDiscoveryIncomplete: '部分 Skills 目录暂时不可用，已保存的授权仍保留。',
        capabilityAccess: '功能授权', capabilityTerminal: '终端', capabilityFiles: '文件读写与命令执行', capabilityAttachments: '附件上传下载', capabilityTasks: '任务与计划', capabilitySubagents: '子智能体与委派', capabilityInteractions: '交互问答', toolAccess: '工具授权', inheritTools: '继承宿主可用工具', customTools: '自定义工具', toolsNote: '自定义列表留空会禁用所有工具；功能开关同时约束工具和对应界面请求。',
        routes: 'DSH 已配置模型', routeNote: '展示宿主已配置的模型与实际支持的思考等级。账号默认继承全部模型，admin 可改为自定义授权或禁用。',
        editRoute: '编辑路由', newRoute: '新增路由', routeId: '路由 ID（新增可留空）', label: '显示标签', provider: 'Provider key', model: 'Model',
        enabled: '启用路由', globalDefault: '平台默认路由', saveRoute: '发布路由元数据',
        environment: '高级：自定义目录（只读）', environmentNote: '此处仅只读展示已发布目录的资源 ID。为避免旧版仅 ID 写入使内容关联失效，请在独立成员入口以管理员账号编辑完整共享配置；本页不自动导入宿主资源。',
        skills: 'Skills', mcp: 'MCP', agents: 'Agents', publishEnvironment: '发布共享目录', environmentVersion: '目录版本',
        noUsers: '尚未取得账号列表。', noAdmin: '未取得管理员快照，请刷新；不会以客户端角色代替服务端授权。',
        noEnvironment: '尚未发布共享环境目录。', backendError: '服务端错误', setupHeader: '首次设置确认',
      },
      en: {
        searchModels: 'Search provider or model', effortLevels: 'levels', selectedVariants: 'Selected / available efforts', searchResources: 'Search resource name or description', pageSize: 'Models per page', previousPage: 'Previous page', nextPage: 'Next page', modelsCount: 'models', variantsCount: 'combinations', noMatches: 'No matching items.', allShared: 'All compatible resources shared by default', selectivelyShared: 'Custom sharing scope', sharedResource: 'Shared', notSharedResource: 'Not shared', selectPage: 'Select this page', clearPage: 'Clear this page', description: 'Description', noDescription: 'No description provided.', expandDescription: 'Expand', collapseDescription: 'Collapse', saveSharing: 'Save sharing scope', reloadSharing: 'Reload and discard draft', sharingNotice: 'Changing sharing stops current projects. Files and history are retained; reopen projects to apply the change.', sharingFailed: 'Save failed. Your draft is preserved. Explicitly reload before editing again to avoid overwriting newer sharing policy.',
        modelDefault: 'Model default (no effort override)',
        title: 'Multi-user service', subtitle: 'Member accounts, permissions and server resources', currentAccount: 'Current account',
        workspaceInfo: 'Workspace help', infoClose: 'Close help', accessHelp: 'Access', accessNote: 'The member entry uses this same service. A different hostname separates owner permissions. Sign in with a workspace account.', enterMember: 'Open member workspace ↗', checkIsolation: 'Check isolation', checkingIsolation: 'Checking…', isolationPassed: 'Checks passed', isolationFailed: 'Checks failed', isolationRestart: 'Disable and re-enable this plugin before retrying.', isolationRetry: 'Check the system environment and retry.',
        discardEdit: 'Discard unsaved account changes?', discardChanges: 'Discard changes', keepEditing: 'Keep editing',
        userHome: 'Personal workspace directory', homeAlias: 'Home directory', homeReady: 'Automatically allocated', homePending: 'Waiting for automatic allocation', homeUnavailable: 'Directory status is unavailable. Refresh or contact an administrator.', homeAutomatic: 'Each account gets a directory automatically, without model access. Projects mount only their own subdirectory.', homeDirectory: 'User home directories', homeRoot: 'Shared root directory (absolute Linux path)', homeCurrentRoot: 'Current root', homeDefaultRoot: 'Startup default root', homeRootNote: 'Use an absolute directory on this server. Changes apply only to newly allocated users; existing directories and projects are not migrated.', homeRootSave: 'Save home directory', homeRootReload: 'Reload and discard directory draft', homeRootFailed: 'The save failed or the configuration changed. Your draft is preserved. Explicitly reload before editing again to avoid overwriting newer directory settings.', homeRootUnknown: 'Directory settings are unavailable. Refresh to retry.', legacyReservations: 'Compatibility: project metadata reservations',
        accountsTab: 'Accounts', modelsTab: 'Models', sharingTab: 'Shared environment', advancedTab: 'Advanced', searchAccounts: 'Search accounts or display names', newAccount: 'New account', inviteAccount: 'Invite member', editAccount: 'Edit', closePanel: 'Close', accountRole: 'Role', accountStatus: 'Status', accountVariants: 'Allowed variants', accountActions: 'Actions', accountCount: 'Accounts', modelCount: 'Configured models', sharedCount: 'Shared resources', boundaryDetails: 'Permission boundaries', runtimeReadyBadge: 'Isolated runtime ready', runtimePendingBadge: 'Runtime check pending', runtimeUnknownBadge: 'Runtime status unknown', advancedNote: 'Optional custom directory for inspecting published resource IDs.', dangerZone: 'Password and sign-in security', accountsNote: 'Manage workspace sign-in and model access.', noAccountMatches: 'No matching accounts.',
        boundary: 'Owner management entry · members use a separate entry', ownerBoundaryShort: 'Owner management only. Do not share this address with members.',
        memberEntry: 'Separate member entry', memberEntryNote: 'Open the server-provided entry on a different hostname and sign in separately with a workspace account. This does not forward owner authority or this panel’s sign-in credentials. Use that entry for real conversations and native DSH terminals.', memberEntryMissing: 'A valid separate member address is not available. It must use a different hostname. Refresh service status or check server configuration; do not share the current owner address.', runtimeStatus: 'Isolated runtime check', runtimeReady: 'Execution is provided by DSH. Each action still verifies account and session permissions.', runtimePending: 'Checked when a project is first opened. Failed checks never run on the host.', runtimeUnknown: 'Status unavailable. Refresh to retry.',
        ownerOnly: 'This panel still uses the personal DSH owner connection. Do not share this entry with members. Plugin sign-in does not change host privileges; existing conversations are unchanged.',
        metadataOnly: 'This panel manages accounts and model authorization without changing personal DSH conversations. Projects follow the compatible DSH startup environment by default. Administrators can manage optional custom overrides through the separate member entry.',
        workspace: 'Workspace', usage: 'Usage board', admin: 'Administration', refresh: 'Refresh', loading: 'Loading…', pending: 'Submitting…',
        login: 'Sign in', redeem: 'Accept invitation', bootstrap: 'Create first administrator', logout: 'Sign out',
        username: 'Username', displayName: 'Display name', password: 'Password', longPassword: 'Long password (at least 16 characters)',
        inviteToken: 'Invitation token', setupNote: 'First-time initialization only. The current owner must explicitly submit this operation; an administrator is never created automatically.',
        setupConsent: 'I confirm initialization of the first administrator through this DSH owner connection', invitationOnly: 'No public sign-up. New members need an administrator invitation.',
        rememberLogin: 'Stay signed in and remember username', memoryOnly: 'Persistent sign-in is restored through an HttpOnly cookie and can be revoked by signing out. Only the username is saved here. Choose to save passwords in your browser’s password manager; this page never stores passwords or tokens in local storage.',
        retry: 'Retry', unknown: 'Unknown', requestFailed: 'Request failed. Check the local service and retry.', invalidResponse: 'The service returned an unrecognized response.',
        expired: 'Your session expired. Please sign in again.', timeout: 'Request timed out. Please retry.', csrfMissing: 'Session CSRF credentials are missing. Please sign in again.',
        signedIn: 'Signed in', memberRole: 'Member', adminRole: 'Administrator', noSnapshot: 'Account state is not available yet. Refresh to retry.',
        projects: 'My project reservations', noProjects: 'No reservations yet. A reservation stores metadata only; it does not start a conversation or allocate host execution.',
        newProject: 'New project reservation', projectTitle: 'Project name', route: 'Model and reasoning effort', chooseRoute: 'Choose an authorized model and effort', noRoutes: 'No model and effort choices are available. Ask an administrator to authorize them.',
        reserve: 'Create reservation', reservation: 'Project reservation view only', reservationNote: 'This owner API stores project reservations only. It does not start a real conversation or bind a personal DSH session. Create or open projects through the separate member entry for controlled chat and isolated terminals.',
        selectProject: 'Choose a project on the left to inspect its reservation and isolation status.', rename: 'Save name', projectId: 'Project ID', routeUnavailable: 'Original route is currently unavailable',
        terminal: 'Project terminal', terminalUnavailable: 'Open terminals through the separate member entry', terminalNote: 'Use native DSH terminals through the member entry. Execution and security follow the current DSH configuration.',
        isolationCode: 'ISOLATION_UNAVAILABLE', created: 'Project reservation created.', saved: 'Saved.',
        accountConflict: 'This account changed elsewhere. Your draft is kept. Reload before editing to avoid overwriting the latest permissions or status.', reloadAccount: 'Discard draft and reload account',
        changePassword: 'Change sign-in password', currentPassword: 'Current password', confirmPassword: 'Confirm new password', passwordChangeNote: 'This signs out every login for this account and stops current execution. Sign in again with your new password.', passwordMismatch: 'The new passwords do not match.', currentPasswordInvalid: 'The current password is incorrect.', passwordUnchanged: 'Choose a password different from the current one.', passwordChanged: 'Password changed. Sign in with your new password.', passwordRateLimit: 'Too many attempts. Try again later.',
        invitationHistory: 'Invitation history', invitePending: 'Pending', inviteUsed: 'Used', inviteExpired: 'Expired', inviteRevoked: 'Revoked', revokeInvite: 'Revoke', reissueInvite: 'Reissue', invitationEmpty: 'No invitations yet.', inviteLink: 'Invitation link', copyInviteLink: 'Copy invitation link', linkCopied: 'Copied', linkSelectCopy: 'Copy the selected link', invitationHistoryNote: 'Invitations are single-use and expire after 24 hours. Reissuing invalidates the old link without affecting existing members.', inviteConflict: 'Invitation status changed. Refresh and try again.',
        accountRole: 'Account role', roleNote: 'Administrators manage all members, grants and shared settings. Promote the successor before demoting the former administrator. Role changes require a new sign-in.', lastAdmin: 'Keep at least one enabled administrator before transferring or disabling access.', identityChanged: 'Account identity changed. Sign in again.', 'owner.recoverAdministrator': 'Recover administrator', recoveryNote: 'Available only in the native DSH owner page after DSH authorization. Enter an existing administrator username and a new password. All old logins for this account will be revoked.', recoveryConsent: 'Reset this administrator password and revoke all old logins', administratorRecovered: 'Administrator recovered. Sign in with the new password.',
        copyGrants: 'Use member grants (optional)', chooseGrantSource: 'Choose a member as a template', applyGrantCopy: 'Apply grants', grantsCopied: 'Grants applied to this form. Save to take effect.', grantCopyNote: 'Reuses model, capability and directory grants only.', findOtherMember: 'Find another member', effectiveAccess: 'View saved effective access', effectiveAccessNote: 'Saved account grants and personal choices are shown below. Save drafts to apply them. Actual calls also depend on resources enabled in DSH and feature constraints.', grantedColumn: 'Administrator grant', selectedColumn: 'Personal choice', effectiveColumn: 'Effective access', scopeAll: 'Inherit all', scopeNone: 'None', scopeEnabled: 'On', scopeDisabled: 'Off', effectiveModels: 'Available models now', accountDisabledNote: 'This account is disabled. No usage permissions take effect.',
        grantLimited: 'Limited by administrator grant', personallyLimited: 'Reduced by personal choice', accountUnavailable: 'Account disabled', memberPickerHint: 'Choose or search for a member', memberTooMany: 'Many members match. Keep typing to narrow the results.',
        allTime: 'All time · server aggregates', usageNote: 'Only display names and aggregate usage are public. Other members’ projects, prompts, files and route credentials are not shown.',
        usageUnknown: 'Some usage is unknown. Unknown values are not counted as zero.', usageEmpty: 'No server usage records yet. This does not mean usage is zero.',
        calls: 'Calls', inputTokens: 'Input tokens', outputTokens: 'Output tokens', totalTokens: 'Total tokens', unknownCalls: 'Calls with unknown usage',
        accounts: 'Accounts and invitations', createUser: 'Create member account', createInvite: 'Generate single-use invitation', inviteOnce: 'The invitation token is shown only in this response. Transfer it securely.', expiresAt: 'Expires at',
        accountSetupProgress: 'Account creation progress', accountSetupInfo: 'Account details', accountSetupPermissions: 'Permissions', accountSetupInfoNote: 'Enter the username, display name and sign-in password.', accountSetupPermissionsNote: 'Choose the models, capabilities and directories for this account, then create it.', accountSetupNext: 'Next', accountSetupBack: 'Back',
        inviteSetupProgress: 'Invitation progress', inviteSetupInfo: 'Invitation details', inviteSetupInfoNote: 'Optionally enter a display name. The member chooses their account and password when accepting.', inviteSetupPermissionsNote: 'Choose the models, capabilities and directories available after accepting this invitation.', inviteReady: 'Invitation ready', accountSetupDone: 'Done',
        optionalName: 'Display name (optional)', routeAllowlist: 'Allowed models and reasoning efforts', defaultRoute: 'Default model and effort', noDefault: 'No default model',
        editUser: 'Account access and status', selectUser: 'Choose an account', disabled: 'Disable account', active: 'Active', disabledState: 'Disabled',
        accountNote: 'Disabling an account or resetting its password revokes all its sessions. The last active administrator cannot be disabled.',
        saveAccess: 'Save account access', resetPassword: 'Reset password', resetConsent: 'I confirm revoking this account’s sessions and setting a new password',
        modelAccess: 'Model access', inheritModels: 'Inherit all host models', customModels: 'Custom access', inheritModelsNote: 'Follow the host models and default selection, including models added later.', customModelsNote: 'Allow only the selected model and reasoning combinations. An empty selection disables model access.',
        skillAccess: 'Skill access', inheritSkills: 'Inherit all host skills', customSkills: 'Custom skills', skillsNote: 'An empty custom list disables skills. Catalogs and content reads follow the same authorization.', skillDiscoveryIncomplete: 'Some skill catalogs are temporarily unavailable. Saved grants are retained.',
        agentPresetAccess: 'Agent preset access', inheritAgentPresets: 'Inherit all host Agent presets', customAgentPresets: 'Custom Agent presets', agentPresetsNote: 'Only selected presets are allowed. An empty custom list disables Agent creation. New sessions default to an allowed preset without changing the host default.',
        permissionPresetAccess: 'Permission preset access', inheritPermissionPresets: 'Inherit all host permission presets', customPermissionPresets: 'Custom permission presets', permissionPresetsNote: 'Presets apply only within personal and authorized shared directories. Full access cannot remove this boundary. An empty custom list blocks session startup.',
        pluginAccess: 'Tool plugin access', inheritPlugins: 'Inherit all host tool plugins', customPlugins: 'Custom tool plugins', pluginsNote: 'Authorize the native plugin that owns each tool, together with tool lists and feature switches. An empty custom list disables plugin tools without changing server installation or global settings.', pluginDiscoveryIncomplete: 'Some tool origins are unavailable. Custom grants deny those tools.',
        mcpAccess: 'MCP server access', inheritMcp: 'Inherit configured host MCP servers', customMcp: 'Custom MCP servers', mcpNote: 'Server grants apply to tool calls and resource reads. An empty custom list disables MCP. Connections and credentials stay on the host.', noMcpServers: 'The host has no registered MCP servers.',
        nativeSharingNote: 'Members inherit existing host capabilities. Set each account’s tool plugins, MCP servers, skills, models and file access in Accounts. Counts below come from the current native registries.',
        sharedDirectories: 'Shared directories', sharedDirectoriesNote: 'Grant shared directories, read-only by default. File tools, commands and scripts all obey these grants. The grants are inactive when file access is disabled.', directoryPath: 'Server directory path', directoryMode: 'Access', directoryReadOnly: 'Read-only', directoryReadWrite: 'Read and write', addDirectory: 'Add directory', removeDirectory: 'Remove directory',
        capabilityAccess: 'Feature access', capabilityTerminal: 'Terminal', capabilityFiles: 'Files and command execution', capabilityAttachments: 'File uploads and downloads', capabilityTasks: 'Tasks and schedules', capabilitySubagents: 'Subagents and delegation', capabilityInteractions: 'Interactive questions', toolAccess: 'Tool access', inheritTools: 'Inherit available host tools', customTools: 'Custom tools', toolsNote: 'An empty custom list disables all tools. Feature switches apply to tools and their corresponding interface requests.',
        routes: 'Models configured in DSH', routeNote: 'Shows configured host models and their supported reasoning efforts. Accounts inherit all models by default; admin can restrict or disable access.',
        editRoute: 'Edit route', newRoute: 'New route', routeId: 'Route ID (optional for a new route)', label: 'Display label', provider: 'Provider key', model: 'Model',
        enabled: 'Enable route', globalDefault: 'Platform default route', saveRoute: 'Publish route metadata',
        environment: 'Advanced: custom directory (read-only)', environmentNote: 'Resource IDs in the published directory are read-only here. To avoid invalidating content associations with legacy ID-only writes, sign in as an administrator through the separate member entry to edit full shared configuration. Host resources are not imported automatically.',
        skills: 'Skills', mcp: 'MCP', agents: 'Agents', publishEnvironment: 'Publish shared directory', environmentVersion: 'Directory version',
        noUsers: 'Account list is not available yet.', noAdmin: 'Administrator snapshot is unavailable. Refresh to retry; client roles never replace server authorization.',
        noEnvironment: 'No shared environment directory published yet.', backendError: 'Server error', setupHeader: 'First-time setup confirmation',
      },
    };

    Object.assign(messages.zh, {
      executionManualTab: '指定工具', executionScannedTab: '扫描工具', executionDialogNote: '管理服务器命令与工具授权。', executionManualHint: '添加服务器上已安装的命令，也可导入已有配置。', executionScannedHint: '从已登记的来源扫描工具，再配置使用范围。', executionMore: '更多操作', executionNotes: '使用说明', sharingResourcesTab: '资源概览', sessionsDescription: '按成员查看和管理会话记录。', filesDescription: '按成员管理个人目录内的文件与文件夹。', ownSessionsDescription: '查看和管理自己的会话记录。', ownFilesDescription: '管理自己目录内的文件与文件夹。',
      toolsPerPage: '每页工具数', executionToolsCount: '个工具', navigationPersonal: '个人', navigationWorkspace: '工作区', navigationManagement: '服务管理',
      toolBlacklist: '黑名单 · 默认开放', toolWhitelist: '白名单 · 仅允许所选', toolBlacklistNote: '勾选要禁用的工具；不勾选则全部开放，新增工具默认可用。功能和资源权限同时生效。', toolWhitelistNote: '勾选要允许的工具；不勾选则全部禁用，新增工具需单独允许。功能和资源权限同时生效。',
      manageAccountAccess: '管理账号授权', permissionsHint: '默认继承宿主配置，可按需调整功能与访问范围。', inheritSummary: '继承宿主', customSummary: '自定义', directoryCount: '个共享目录', personalDirectoryOnly: '仅个人目录', cancelEdit: '取消', accountRows: '个账号', accountPageSize: '每页账号', filterAll: '全部', filterEnabled: '启用', filterDisabled: '已禁用', accountVariants: '模型权限',
      workspaceInfo: '使用说明', helpIntro: '一套 DSH 服务供团队多人使用，管理员统一管理，每位成员拥有独立的会话与文件空间。', accessHelp: '成员入口', accessNote: '将此地址分享给能访问服务器的成员，使用各自的成员账号登录。', memberEntryMissing: '成员入口暂不可用，请刷新状态或检查服务端地址设置。', runtimeStatus: 'DSH 执行环境', runtimeAutoCheck: '沿用 DSH 原生能力', isolationNote: '成员文件、脚本、终端和代码执行仅可读写本人目录与授权共享目录；完全访问不能越过此边界。未通过原生目录隔离校验时禁止执行。', checkIsolation: '检查运行环境', helpDirectory: '界面按账号管理会话与文件，管理员可管理成员内容；共享目录由管理员另行授权。', helpSharing: '模型、工具插件、Skills 和 MCP 沿用宿主配置。管理员可在账号授权中调整各成员的可用范围。',
      usageUnknown: '部分记录的用量未知；带 ≥ 的数字为已知用量，未将未知部分计作 0。',
      accountAuthorization: '账号授权', accessMode: '授权方式', resourcesAndDirectories: '资源与目录',
      subtitle: '共享宿主能力，管理成员与访问范围', saveAccess: '保存授权',
      modelAccess: '模型', inheritModels: '使用宿主全部模型', customModels: '选择可用模型', inheritModelsNote: '沿用宿主的模型与默认设置，自动包含新增模型。', customModelsNote: '仅开放选中的模型与思考等级；未选择则不可用。', routeAllowlist: '可用模型', defaultRoute: '默认模型', noDefault: '由会话选择',
      capabilityAccess: '功能', capabilityFiles: '文件与命令', capabilitySubagents: '子智能体', capabilityAttachments: '附件传输', capabilityInteractions: '交互问答', toolAccess: '可用工具', toolsNote: '仅开放选中的工具；未选择则不可用。功能开关同时生效。',
      skillAccess: 'Skills', agentPresetAccess: 'Agent 预设', permissionPresetAccess: '执行权限预设', pluginAccess: '工具插件', mcpAccess: 'MCP 服务',
      skillsNote: '仅开放选中的 Skills；未选择则不可用。', agentPresetsNote: '仅开放选中的预设；未选择则无法创建会话。', pluginsNote: '仅开放选中插件提供的工具，功能和工具授权同时生效。', mcpNote: '仅开放选中服务的工具与资源；连接与凭据由宿主管理。',
      nativeSharingNote: '成员共享宿主已启用的资源，使用各自的独立目录。可在账号授权中调整每位成员的可用范围。',
      homeDirectory: '工作目录', homeRoot: '新成员的目录位置', homeRootNote: '系统自动为成员分配独立目录。修改此位置仅影响新成员，已有目录保持原位。使用服务器上的绝对路径。', homeRootSave: '保存目录设置', homeRootReload: '重新加载设置',
      usageNote: '公开各账号的汇总用量，保留对话与文件隐私。', usageUnknown: '≥ 表示已知用量下限；缺少结算数据的调用单独计数。', unknownCalls: '未知调用数', allTime: '累计用量',
brandingTab: '品牌外观', brandingTitle: '品牌标识', brandingNote: '自定义侧栏名称、标签和共享 Logo，以及首页标语。所有成员统一使用。', brandPreview: '首页预览', brandLogo: 'Logo', brandLogoNote: '支持 SVG、PNG、JPEG、WebP，原文件大小不限。自动优化，保持比例完整显示。也可填写图片地址。', brandLogoUrl: '图片地址', brandUploaded: '已使用上传的图片', brandSlogan: '首页标语', brandSloganNote: '最多 80 个字符，留空使用 DSH 默认标语。', brandSave: '保存外观', brandReset: '使用默认外观', brandReload: '重新加载设置', brandConflict: '外观已被其他管理员更新。草稿已保留，请重新加载后再修改。', brandImageError: '图片无法显示，将使用默认 Logo。', brandFileError: '无法读取图片，请选择有效的 SVG、PNG、JPEG 或 WebP 图片。', brandSaveError: '保存失败，草稿已保留。',
      brandName: '侧栏名称', brandBadge: '侧栏标签', brandNameNote: '侧栏与登录页共用。名称最多 40 字，留空使用 deepseek；标签最多 16 字，留空不显示。', brandSidebarPreview: '侧栏与登录页预览',
      brandShowPreviewBadge: '显示“预览版”标签', brandPreviewBadgeNote: '控制首页标签的显示，所有成员统一使用。',
      contentNoMessages: '此会话暂无消息。', contentStopRequested: '已发送停止请求。', contentType: '类型', contentPreview: '管理预览', contentPreviewReadOnly: '管理员只读查看，编辑操作请返回工作区管理。', contentEndPreview: '结束预览', contentEditText: '编辑文本', contentFileView: '查看文件',
      contentTab: '会话与文件', contentNote: '按成员查看会话记录，管理个人目录内的文件。', contentSessions: '会话', contentFiles: '文件', contentAllUsers: '所有成员', contentMember: '成员', contentSearch: '搜索会话名称或成员', contentArchived: '显示已归档会话', contentEmpty: '没有匹配的会话。', contentEmptyFolder: '此目录为空。', contentRefresh: '刷新', contentOwner: '所属成员', contentStatus: '状态', contentActions: '操作', contentManage: '管理', contentView: '查看记录', contentRename: '重命名', contentArchive: '归档', contentRestore: '恢复', contentStop: '停止运行', contentHistory: '会话记录', contentOlder: '加载更早记录', contentRunning: '运行中', contentIdle: '空闲', contentArchivedState: '已归档', contentOpenFiles: '管理文件', contentFolder: '文件夹', contentFile: '文件', contentLink: '符号链接', contentSize: '大小', contentRoot: '个人目录', contentUp: '上一级', contentNewFolder: '新建文件夹', contentNewFile: '新建文件', contentUpload: '上传文件', contentDownload: '下载', contentReplace: '替换文件', contentMove: '移动', contentDelete: '删除', contentName: '名称', contentDestination: '目标目录（相对个人目录）', contentText: '文件内容', contentBinary: '此文件不支持在线编辑，可下载或替换原文件。', contentBound: '会话工作目录位置固定，可管理其中的文件与子目录。', contentConfirmDelete: '删除此项及其中的所有内容？此操作无法撤销。', contentSave: '保存', contentCreate: '创建', contentCancel: '取消', contentPrev: '上一页', contentNext: '下一页', contentCount: '共', contentFailed: '操作失败，请重试。', contentDone: '已完成', contentBusy: '正在处理', contentCancelTransfer: '取消传输', contentRowTitle: '会话名称', contentModified: '最后修改', contentMessageUser: '成员', contentMessageAssistant: '助手', contentMessageTool: '工具', contentConflict: '内容已被修改，请重新加载后再保存。', contentExists: '目标已存在，请选择其他名称。', contentLinkDenied: '不能通过符号链接访问目录或文件。', contentTruncated: '内容较长，仅显示前 64K 字符。',
    });
    Object.assign(messages.en, {
      executionManualTab: 'Specified tools', executionScannedTab: 'Scanned tools', executionDialogNote: 'Manage server commands and tool access.', executionManualHint: 'Add commands installed on the server, or import an existing configuration.', executionScannedHint: 'Scan registered sources, then configure tool access.', executionMore: 'More actions', executionNotes: 'Usage notes', sharingResourcesTab: 'Resources', sessionsDescription: 'Review and manage conversations by member.', filesDescription: 'Manage files and folders in member directories.', ownSessionsDescription: 'Review and manage your own conversations.', ownFilesDescription: 'Manage files and folders in your own directory.',
      toolsPerPage: 'Tools per page', executionToolsCount: 'tools', navigationPersonal: 'Personal', navigationWorkspace: 'Workspace', navigationManagement: 'Service management',
      toolBlacklist: 'Blacklist · allow by default', toolWhitelist: 'Whitelist · selected tools only', toolBlacklistNote: 'Check tools to block. An empty list allows all tools, including new tools. Feature and resource permissions still apply.', toolWhitelistNote: 'Check tools to allow. An empty list blocks all tools; new tools require selection. Feature and resource permissions still apply.',
      manageAccountAccess: 'Manage account access', permissionsHint: 'Host settings are inherited by default. Adjust capabilities and scope as needed.', inheritSummary: 'Inherit host', customSummary: 'Custom', directoryCount: 'shared directories', personalDirectoryOnly: 'Personal directory only', cancelEdit: 'Cancel', accountRows: 'accounts', accountPageSize: 'Accounts per page', filterAll: 'All', filterEnabled: 'Enabled', filterDisabled: 'Disabled', accountVariants: 'Model access',
      workspaceInfo: 'Workspace guide', helpIntro: 'One DSH server for your team, with central administration and individual conversations and files.', accessHelp: 'Member entry', accessNote: 'Share this address with members who can reach the server. Each member signs in with their own account.', memberEntryMissing: 'The member address is unavailable. Refresh or check the server address settings.', runtimeStatus: 'DSH execution', runtimeAutoCheck: 'Native DSH providers', isolationNote: 'Member files, scripts, terminals and code stay within personal and authorized shared directories. Full access cannot remove this boundary. Execution is denied when native directory enforcement is unavailable.', checkIsolation: 'Check runtime', helpDirectory: 'Conversations and managed files are scoped by account. Administrators can manage member content and grant shared directories.', helpSharing: 'Models, tool plugins, Skills and MCP use the host configuration. Administrators can adjust each account’s access.',
      usageUnknown: 'Some records have unknown usage. Values marked ≥ show known usage; unknown amounts are not counted as zero.',
      accountAuthorization: 'Account access', accessMode: 'Access mode', resourcesAndDirectories: 'Resources and directories',
      brandingTab: 'Branding', brandingTitle: 'Brand identity', brandingNote: 'Customize the sidebar name and badge, shared logo, and home slogan for all members.', brandPreview: 'Home preview', brandLogo: 'Logo', brandLogoNote: 'SVG, PNG, JPEG and WebP supported, with no source file size limit. Optimized to fit without cropping or distortion. Image URLs also supported.', brandLogoUrl: 'Image URL', brandUploaded: 'Using the uploaded image', brandSlogan: 'Home slogan', brandSloganNote: 'Up to 80 characters. Leave blank for the DSH default.', brandSave: 'Save appearance', brandReset: 'Use default appearance', brandReload: 'Reload settings', brandConflict: 'Another administrator updated the appearance. Your draft is preserved; reload before editing again.', brandImageError: 'The image is unavailable. The default logo will be used.', brandFileError: 'The image could not be read. Choose a valid SVG, PNG, JPEG or WebP image.', brandSaveError: 'Save failed. Your draft is preserved.',
      brandName: 'Sidebar name', brandBadge: 'Sidebar badge', brandNameNote: 'Shared with the sign-in pages. Name: up to 40 characters; blank uses deepseek. Badge: up to 16 characters; blank hides it.', brandSidebarPreview: 'Sidebar & sign-in preview',
      brandShowPreviewBadge: 'Show the “Preview” badge', brandPreviewBadgeNote: 'Controls the home badge for all members.',
      contentNoMessages: 'This conversation has no messages yet.', contentStopRequested: 'Stop requested.', contentType: 'Type', contentPreview: 'Admin preview', contentPreviewReadOnly: 'Read-only administrator preview. Edit through workspace administration.', contentEndPreview: 'End preview', contentEditText: 'Edit text', contentFileView: 'View file',
      contentTab: 'Sessions & files', contentNote: 'Review member conversations and manage files in their personal directories.', contentSessions: 'Sessions', contentFiles: 'Files', contentAllUsers: 'All members', contentMember: 'Member', contentSearch: 'Search sessions or members', contentArchived: 'Include archived sessions', contentEmpty: 'No matching sessions.', contentEmptyFolder: 'This directory is empty.', contentRefresh: 'Refresh', contentOwner: 'Member', contentStatus: 'Status', contentActions: 'Actions', contentManage: 'Manage', contentView: 'View history', contentRename: 'Rename', contentArchive: 'Archive', contentRestore: 'Restore', contentStop: 'Stop running', contentHistory: 'Conversation history', contentOlder: 'Load earlier messages', contentRunning: 'Running', contentIdle: 'Idle', contentArchivedState: 'Archived', contentOpenFiles: 'Manage files', contentFolder: 'Folder', contentFile: 'File', contentLink: 'Symbolic link', contentSize: 'Size', contentRoot: 'Personal directory', contentUp: 'Up', contentNewFolder: 'New folder', contentNewFile: 'New file', contentUpload: 'Upload files', contentDownload: 'Download', contentReplace: 'Replace file', contentMove: 'Move', contentDelete: 'Delete', contentName: 'Name', contentDestination: 'Destination directory (relative to personal directory)', contentText: 'File content', contentBinary: 'This file cannot be edited online. Download or replace the original file.', contentBound: 'Session working directories keep their location. Manage files and subfolders inside them.', contentConfirmDelete: 'Delete this item and all its contents? This cannot be undone.', contentSave: 'Save', contentCreate: 'Create', contentCancel: 'Cancel', contentPrev: 'Previous', contentNext: 'Next', contentCount: 'Total', contentFailed: 'The operation failed. Try again.', contentDone: 'Completed', contentBusy: 'Working', contentCancelTransfer: 'Cancel transfer', contentRowTitle: 'Conversation', contentModified: 'Modified', contentMessageUser: 'Member', contentMessageAssistant: 'Assistant', contentMessageTool: 'Tool', contentConflict: 'The content changed. Reload it before saving.', contentExists: 'The destination exists. Choose another name.', contentLinkDenied: 'Directories and files cannot be accessed through symbolic links.', contentTruncated: 'Long content: showing the first 64K characters.',
    });
    Object.assign(messages.zh, {
      limitsTab: '用量与并发', limitsTitle: '用量与并发额度', limitsNote: '按北京时间自然日、自然月统计。留空表示不限，填 0 暂停新任务；子 Agent 也占并发名额。调整额度不会中断正在执行的请求。',
      maxConcurrent: '同时运行任务数', dailyTokens: '每日 tokens 上限', monthlyTokens: '每月 tokens 上限', unlimited: '不限', saveLimits: '保存额度', limitsUnknown: '存在未知用量时，已设置 tokens 上限的账号会暂停新请求，直到记录可核对或管理员取消上限。',
      limitsActive: '当前运行任务', limitsDayUsed: '今日 tokens', limitsMonthUsed: '本月 tokens', limitsOwn: '我的额度',
    });
    Object.assign(messages.en, {
      limitsTab: 'Usage limits', limitsTitle: 'Usage and concurrency', limitsNote: 'Calendar days and months use Asia/Shanghai time. Blank means unlimited; 0 pauses new work. Child Agents use concurrency slots too. Changes do not interrupt requests already running.',
      maxConcurrent: 'Concurrent tasks', dailyTokens: 'Daily token limit', monthlyTokens: 'Monthly token limit', unlimited: 'Unlimited', saveLimits: 'Save limits', limitsUnknown: 'When token usage is unknown, accounts with token limits pause new requests until records are available or an administrator removes the limit.',
      limitsActive: 'Running tasks', limitsDayUsed: 'Tokens today', limitsMonthUsed: 'Tokens this month', limitsOwn: 'My limits',
    });
    Object.assign(messages.zh, {
      recycleBin: '回收站', recycleNote: '恢复到原位置；同名文件会保留，不会被覆盖。', recycleOriginal: '原位置', recycleDeletedAt: '删除时间', recycleEmpty: '回收站为空。', recycleRestore: '恢复', recyclePurge: '永久删除', recyclePurgeConfirm: '永久删除此项及全部内容？此操作无法撤销。', contentRecycled: '已移入回收站，可在回收站中恢复。', contentConfirmDelete: '将此项及其中的内容移入回收站？之后可从回收站恢复。',
    });
    Object.assign(messages.en, {
      recycleBin: 'Recycle bin', recycleNote: 'Restore to the original location. Existing items are never replaced.', recycleOriginal: 'Original location', recycleDeletedAt: 'Deleted', recycleEmpty: 'The recycle bin is empty.', recycleRestore: 'Restore', recyclePurge: 'Delete permanently', recyclePurgeConfirm: 'Permanently delete this item and all contents? This cannot be undone.', contentRecycled: 'Moved to the recycle bin. You can restore it there.', contentConfirmDelete: 'Move this item and its contents to the recycle bin? You can restore them later.',
    });
    Object.assign(messages.zh, {
      contentSearch: '搜索会话', sessionSearchHint: '会话名称、成员或会话 ID', fileSearch: '搜索当前目录', fileSearchHint: '文件或文件夹名称', advancedFilters: '高级筛选', filterNote: '选择条件后应用；默认隐藏空会话。', fileFilterNote: '筛选当前目录中的文件和文件夹。', filterContent: '会话内容', filterMessages: '有消息的会话', filterAllContent: '全部（含空会话）', filterEmpty: '仅空会话', filterStatus: '运行状态', filterAny: '全部', filterArchive: '归档状态', filterActive: '未归档', filterArchived: '已归档', filterScope: '搜索范围', filterScopeAll: '名称、成员和 ID', filterScopeTitle: '仅会话名称', filterScopeMember: '仅成员', filterScopeId: '仅会话 ID', filterSort: '排序', filterNewest: '最近更新优先', filterOldest: '最早更新优先', filterName: '名称 A–Z', filterNameDesc: '名称 Z–A', filterLargest: '文件大小从大到小', filterFrom: '更新开始日期', filterTo: '更新结束日期', filterDateNote: '包含起止日期，按当前设备的本地时间筛选。', filterApply: '应用筛选', filterReset: '恢复默认', filterClear: '清除条件', filterDefaultSummary: '默认隐藏空会话 · 仅未归档', filterKind: '项目类型', filterExtensions: '扩展名', filterExtensionsHint: '例如 md, pdf, docx', filterExtensionsNote: '按扩展名筛选时只显示文件。', contentManageFolder: '管理文件夹', contentManageFile: '管理文件', contentOpenFolder: '打开文件夹', contentEmptyHint: '可调整搜索或高级筛选，查看空会话及已归档会话。', contentFileEmptyHint: '可调整搜索或高级筛选，查看其他文件和文件夹。', contentConfirmDelete: '将此项及其中的内容移至回收站？之后可在回收站恢复。',
    });
    Object.assign(messages.en, {
      contentSearch: 'Search conversations', sessionSearchHint: 'Name, member or conversation ID', fileSearch: 'Search this directory', fileSearchHint: 'File or folder name', advancedFilters: 'Advanced filters', filterNote: 'Apply your selection. Empty conversations are hidden by default.', fileFilterNote: 'Filter files and folders in the current directory.', filterContent: 'Conversation content', filterMessages: 'With messages', filterAllContent: 'All, including empty', filterEmpty: 'Empty only', filterStatus: 'Run status', filterAny: 'All', filterArchive: 'Archive status', filterActive: 'Not archived', filterArchived: 'Archived', filterScope: 'Search scope', filterScopeAll: 'Name, member and ID', filterScopeTitle: 'Name only', filterScopeMember: 'Member only', filterScopeId: 'Conversation ID only', filterSort: 'Sort by', filterNewest: 'Recently updated first', filterOldest: 'Oldest updated first', filterName: 'Name A–Z', filterNameDesc: 'Name Z–A', filterLargest: 'Largest files first', filterFrom: 'Updated from', filterTo: 'Updated through', filterDateNote: 'Both dates are inclusive, using this device’s local time.', filterApply: 'Apply filters', filterReset: 'Use defaults', filterClear: 'Clear conditions', filterDefaultSummary: 'Empty conversations hidden · Not archived', filterKind: 'Item type', filterExtensions: 'Extensions', filterExtensionsHint: 'e.g. md, pdf, docx', filterExtensionsNote: 'Extension filters show files only.', contentManageFolder: 'Manage folder', contentManageFile: 'Manage file', contentOpenFolder: 'Open folder', contentEmptyHint: 'Adjust search or advanced filters to include empty or archived conversations.', contentFileEmptyHint: 'Clear conditions to see every item in this directory.', contentConfirmDelete: 'Move this item and its contents to the recycle bin? You can restore them later.',
    });
    messages.zh.contentNoFiles = '没有匹配的文件或文件夹。';
    messages.en.contentNoFiles = 'No matching files or folders.';
    messages.zh.fileDefaultSummary = '当前目录 · 隐藏空文件夹';
    messages.en.fileDefaultSummary = 'Current directory · Empty folders hidden';
    messages.zh.filterFoldersInclude = '包含空文件夹';
    messages.en.filterFoldersInclude = 'Including empty folders';
    Object.assign(messages.zh, { filterEmptyFolders: '空文件夹', filterFoldersAll: '全部显示', filterFoldersHide: '隐藏空文件夹', filterFoldersOnly: '仅空文件夹', filterFoldersNote: '不含任何项目的目录视为空，隐藏文件也计入。' });
    Object.assign(messages.en, { filterEmptyFolders: 'Empty folders', filterFoldersAll: 'Show all', filterFoldersHide: 'Hide empty folders', filterFoldersOnly: 'Empty folders only', filterFoldersNote: 'A folder is empty when it has no entries, including hidden files.' });
    messages.zh.contentBoundMenu = '会话目录，位置固定';
    messages.en.contentBoundMenu = 'Session directory · Fixed location';
    Object.assign(messages.zh, { workspaceEntry: '多用户服务', workspaceAccount: '我的账号', memberAccounts: '成员账号', sharedModels: '共享模型', workspaceNavigation: '多用户服务导航', workspacePage: '工作区页面', accountPageNote: '查看当前身份与登录状态，管理账号安全。', membersPageNote: '管理成员账号、可用能力与访问范围。', modelsPageNote: '查看宿主共享的模型，在成员授权中调整可用范围。', sharingPageNote: '查看共享能力并设置成员的工作目录。', brandingPageNote: '统一设置侧栏标识与首页外观。', serviceSignIn: '使用服务账号', serviceSignInNote: '管理员和成员共用一个登录入口，权限由服务账号决定。DSH 模型账号不会自动成为管理员。', enterService: '进入多用户服务', serverMaintenance: '服务器维护', serviceMaintenanceNote: '仅用于恢复管理员账号，不会自动授予当前模型账号管理权限。' });
    Object.assign(messages.en, { workspaceEntry: 'Multi-user', workspaceAccount: 'My account', memberAccounts: 'Members', sharedModels: 'Shared models', workspaceNavigation: 'Multi-user service navigation', workspacePage: 'Workspace page', accountPageNote: 'Review your identity and sign-in status.', membersPageNote: 'Manage members, available capabilities and access.', modelsPageNote: 'Review shared host models and adjust access per member.', sharingPageNote: 'Review shared capabilities and member workspace directories.', brandingPageNote: 'Set the shared sidebar and home appearance.', serviceSignIn: 'Use your service account', serviceSignInNote: 'Administrators and members share one sign-in. Permissions follow the service account. Model accounts do not receive administrator access.', enterService: 'Enter multi-user service', serverMaintenance: 'Server maintenance', serviceMaintenanceNote: 'Recover an administrator account. This does not grant administrator access to the current model account.' });
    Object.assign(messages.zh, { contentPreviewLoading: '正在加载预览…', contentPreviewLoadFailed: '预览加载失败，请返回管理页面重试。' });
    Object.assign(messages.en, { contentPreviewLoading: 'Loading preview…', contentPreviewLoadFailed: 'Preview could not load. Return to management and try again.' });
    Object.assign(messages.zh, {
      filterArchived: '已归档', archivedAccount: '已归档', deletedAccount: '已删除账号', archiveAccount: '归档账号', restoreAccount: '恢复账号', deleteAccount: '永久删除账号', noArchivedAccounts: '暂无已归档账号。', accountOperationConflict: '账号已在别处更新。请关闭此窗口，刷新列表后重试。',
      archiveAccountNote: '归档后将撤销登录、停止运行，并移至「已归档」列表。账号、权限、会话和文件均保留，可随时恢复。',
      restoreAccountNote: '恢复账号及其原有权限，并保留归档前的启用或停用状态。已结束的运行不会自动重启。',
      deleteAccountNote: '仅永久删除登录账号，保留会话、个人文件和用量记录。管理员仍可在「会话与文件」中查阅历史内容。账号删除后不能恢复。',
      confirmAccountUsername: '输入完整用户名确认', archiveRequired: '请先归档此账号，再进行此操作。', accountArchived: '账号已归档，请先恢复后再编辑。', selfAccount: '请使用另一位管理员登录后归档此账号。', deleteConfirmation: '请输入完整用户名确认删除。',
    });
    Object.assign(messages.en, {
      filterArchived: 'Archived', archivedAccount: 'Archived', deletedAccount: 'Deleted account', archiveAccount: 'Archive account', restoreAccount: 'Restore account', deleteAccount: 'Delete account permanently', noArchivedAccounts: 'No archived accounts.', accountOperationConflict: 'This account changed elsewhere. Close this window, refresh the list and try again.',
      archiveAccountNote: 'Revoke sign-ins, stop running work and move this account to Archived. Keep its permissions, conversations and files; the account can be restored.',
      restoreAccountNote: 'Restore the account and its permissions, keeping its previous enabled or disabled state. Stopped work will not restart automatically.',
      deleteAccountNote: 'Permanently remove the sign-in account. Keep conversations, personal files and usage records, available to administrators under Conversations & files. The account cannot be restored.',
      confirmAccountUsername: 'Enter the full username to confirm', archiveRequired: 'Archive this account before continuing.', accountArchived: 'Restore this archived account before editing.', selfAccount: 'Sign in as another administrator to archive this account.', deleteConfirmation: 'Enter the exact username to confirm deletion.',
    });
    for (const dictionary of Object.values(messages)) Object.assign(dictionary, { accountDescription: dictionary.accountPageNote, accountsDescription: dictionary.membersPageNote, contentDescription: dictionary.contentNote, modelsDescription: dictionary.modelsPageNote, sharingDescription: dictionary.sharingPageNote, brandingDescription: dictionary.brandingPageNote, usageDescription: dictionary.usageNote });
    Object.assign(messages.zh, { workspaceAccount: '我的账号', memberAccounts: '成员管理', usageStatistics: '用量统计', accessModels: '模型权限', accessFeatures: '功能权限', accessLimits: '用量与并发', accessSkills: '技能权限', accessAgents: 'Agent 预设', accessPermissions: '执行权限', accessPlugins: '工具插件', accessMcp: 'MCP 服务', accessDirectories: '目录访问', accessStatus: '账号状态', accessSecurity: '登录安全', accessModelsNote: '设置可用模型、推理等级和默认选择。', accessFeaturesNote: '设置终端、文件、任务等功能的使用范围。', accessLimitsNote: '设置任务并发数，以及每日和每月用量上限。', accessSkillsNote: '选择该成员可以使用的 Skills。', accessAgentsNote: '选择可用的 Agent 预设与工作方式。', accessPermissionsNote: '限制会话可选的执行权限预设。', accessPluginsNote: '设置可用的工具插件，授权同时受功能权限约束。', accessMcpNote: '设置可用的 MCP 服务。', accessDirectoriesNote: '添加可访问的共享目录，并设置读写权限。', accessStatusNote: '管理账号的启用与停用状态。', accessSecurityNote: '重置登录密码，并撤销该账号已有的登录。' });
    Object.assign(messages.en, { workspaceAccount: 'My account', memberAccounts: 'Members', usageStatistics: 'Usage statistics', accessModels: 'Model access', accessFeatures: 'Feature access', accessLimits: 'Usage & concurrency', accessSkills: 'Skill access', accessAgents: 'Agent presets', accessPermissions: 'Execution permissions', accessPlugins: 'Tool plugins', accessMcp: 'MCP services', accessDirectories: 'Directory access', accessStatus: 'Account status', accessSecurity: 'Sign-in security', accessModelsNote: 'Set available models, reasoning levels and the default selection.', accessFeaturesNote: 'Choose access to terminals, files, tasks and other features.', accessLimitsNote: 'Set concurrent tasks and daily or monthly usage limits.', accessSkillsNote: 'Choose the skills this member can use.', accessAgentsNote: 'Choose available Agent presets and working modes.', accessPermissionsNote: 'Limit the execution permission presets available to sessions.', accessPluginsNote: 'Choose tool plugins within the account’s feature permissions.', accessMcpNote: 'Choose available MCP services.', accessDirectoriesNote: 'Add shared directories and set read or write access.', accessStatusNote: 'Manage whether this account is enabled.', accessSecurityNote: 'Reset the password and revoke existing sign-ins.' });
    Object.assign(messages.zh, { maxConcurrentNote: '同一时间可运行的任务数', dailyTokensNote: '按北京时间，每天可使用的 tokens', monthlyTokensNote: '按北京时间，每月可使用的 tokens' });
    Object.assign(messages.en, { maxConcurrentNote: 'Tasks that may run at the same time', dailyTokensNote: 'Tokens per day in Beijing time', monthlyTokensNote: 'Tokens per month in Beijing time' });
    Object.assign(messages.zh, { memberBoundaryNote: '执行仅可访问本人目录与授权共享目录。共享 MCP 和未隔离的工具插件暂不对成员开放。', memberBoundaryUnavailable: '当前主机未通过目录隔离校验，成员执行已禁用。', resourceNotIsolated: '未隔离，成员不可用' });
    Object.assign(messages.en, { memberBoundaryNote: 'Execution is limited to personal and authorized shared directories. Shared MCP servers and unisolated tool plugins are unavailable to members.', memberBoundaryUnavailable: 'This host has no verified directory boundary. Member execution is disabled.', resourceNotIsolated: 'Unisolated; unavailable to members' });
    Object.assign(messages.zh, { accessGroupBase: '基础权限', accessGroupResources: '资源与预设', accessGroupAccount: '账号设置' });
    Object.assign(messages.en, { accessGroupBase: 'Access & limits', accessGroupResources: 'Resources & presets', accessGroupAccount: 'Account settings' });
    Object.assign(messages.zh, { personalTab: '我的能力', preferencesDescription: '在管理员授权范围内选择个人能力，仅影响自己的账号。', personalScope: '个人开关不会安装或启停服务器插件、MCP 服务，也不会改变其他成员的设置。', personalApplyNote: '保存后会停止本人当前执行资源；重新打开会话后按新偏好使用。', personalFunctions: '功能', personalNoResources: '当前没有已授权的可用资源。', personalAdminOff: '管理员未授权，无法自行开启', personalEnabled: '已启用', personalSelected: '已选', personalSave: '保存个人偏好', personalDefaults: '使用全部已授权能力', personalReload: '重新载入并放弃草稿', personalConflict: '个人偏好已在其他页面更新，请重新载入后修改。', personalUnavailable: '个人能力目录暂不可用，请刷新重试。', ownContentDescription: '管理自己的会话、文件和文件夹。', ownFilesDisabled: '文件管理当前未启用，可在“我的能力”查看授权与个人开关。' });
    Object.assign(messages.en, { personalTab: 'My capabilities', preferencesDescription: 'Choose personal capabilities within administrator grants. Only your account is affected.', personalScope: 'Personal switches do not install or stop host plugins or MCP servers, or change other members’ settings.', personalApplyNote: 'Saving stops your current execution resources. Reopen conversations to use the new choices.', personalFunctions: 'Features', personalNoResources: 'No authorized resources are currently available.', personalAdminOff: 'Disabled by the administrator', personalEnabled: 'Enabled', personalSelected: 'Selected', personalSave: 'Save personal preferences', personalDefaults: 'Use all authorized capabilities', personalReload: 'Reload and discard draft', personalConflict: 'Preferences changed on another page. Reload before editing.', personalUnavailable: 'Personal capability catalog is unavailable. Refresh to retry.', ownContentDescription: 'Manage your own conversations, files and folders.', ownFilesDisabled: 'File management is disabled. Review your grants and personal switches in My capabilities.' });
    Object.assign(messages.zh, { accessCapabilities: '能力权限', accessCapabilitiesNote: '设置成员可用的功能与资源，作为个人能力选择的授权上限。' });
    Object.assign(messages.en, { accessCapabilities: 'Capabilities', accessCapabilitiesNote: 'Set the features and resources available for this member’s personal choices.' });
    Object.assign(messages.zh, { personalPreview: '文件预览', personalPreviewReadOnly: '当前为文件只读预览，编辑请返回“文件”。' });
    Object.assign(messages.en, { personalPreview: 'File preview', personalPreviewReadOnly: 'Read-only file preview. Return to Files to edit.' });
    Object.assign(messages.zh, { batchAccess: '批量设置权限', batchSelected: '个账号已选', batchApply: '应用到所选账号', batchClear: '清空选择', batchPage: '选择本页账号', batchSelect: '选择账号', batchScope: '将此权限范围应用到所选账号', batchNote: '只覆盖勾选的权限范围；身份、角色、密码、状态、额度和个人偏好均保留。', batchTemplate: '初始权限来自：', batchLimit: '最多选择 100 个账号，可跨页选择；切换搜索或状态筛选后清空。', batchConflict: '所选账号已发生变化，本次整批未保存。草稿已保留，请重新选择成员后再设置。', batchReselect: '重新选择成员' });
    Object.assign(messages.en, { batchAccess: 'Set permissions in bulk', batchSelected: 'accounts selected', batchApply: 'Apply to selected accounts', batchClear: 'Clear selection', batchPage: 'Select accounts on this page', batchSelect: 'Select account', batchScope: 'Apply this permission group to selected accounts', batchNote: 'Only checked permission groups are replaced. Identity, role, password, status, limits and personal choices are preserved.', batchTemplate: 'Initial permissions from:', batchLimit: 'Select up to 100 accounts across pages. Changing search or status clears the selection.', batchConflict: 'A selected account changed. No accounts were saved. Your draft is retained; select the accounts again before editing.', batchReselect: 'Select accounts again' });
    Object.assign(messages.zh, { setupTitle: '完成首次设置', setupAdminStep: '首次设置 · 1 / 4：创建管理员', setupAdministrator: '管理员', setupDirectories: '成员目录', setupEntry: '访问入口', setupReview: '检查并启用', setupRoot: '成员数据目录', setupRootNote: '每位成员在此目录下获得独立空间。现有账号目录保持原位。', setupShared: '新成员的默认共享目录（可选）', setupSharedNote: '仅添加需要协作访问的目录，默认只读；也可以只使用各自的个人目录。创建成员时仍可单独调整。', setupHost: '成员登录域名或 IP', setupHostHint: '例如 team-server.local。域名解析由网络已有的 mDNS 或 DNS 提供；无法解析时使用备用 IP 入口。', setupPort: '服务固定端口', setupPortNote: '端口沿用当前 DSH 服务配置，调整端口需修改服务配置并重启。', setupSuggestedHost: '使用主机名建议', setupLink: '成员登录入口', setupFallback: '备用 IP 入口', setupModels: '可用模型组合', setupNoModels: '尚未检测到可用模型。请在 DSH 原生模型设置中配置后再发起模型对话。', setupModelsNote: '模型、工具和执行环境沿用 DSH 原生配置。', setupFinish: '完成设置并开放成员登录', setupPendingNote: '设置完成前，成员暂时不能登录使用。', setupConflict: '设置已在其他位置变更，请重新加载后继续。', setupReload: '重新加载设置' });
    Object.assign(messages.en, { setupTitle: 'Complete initial setup', setupAdminStep: 'Initial setup · 1 / 4: administrator', setupAdministrator: 'Administrator', setupDirectories: 'Member storage', setupEntry: 'Access address', setupReview: 'Review & enable', setupRoot: 'Member data directory', setupRootNote: 'Each member receives an individual directory here. Existing account directories stay in place.', setupShared: 'Default shared directories for new members (optional)', setupSharedNote: 'Add collaboration directories only; read-only is the default. Individual grants remain editable when creating members.', setupHost: 'Member sign-in hostname or IP', setupHostHint: 'For example team-server.local. Hostname resolution uses your existing mDNS or DNS. Use the fallback IP when resolution is unavailable.', setupPort: 'Fixed service port', setupPortNote: 'Uses the current DSH service port. Change the service configuration and restart to use another port.', setupSuggestedHost: 'Use suggested hostname', setupLink: 'Member sign-in address', setupFallback: 'Fallback IP address', setupModels: 'Available model variants', setupNoModels: 'No available models were detected. Configure models in native DSH settings before starting model conversations.', setupModelsNote: 'Models, tools and execution use native DSH configuration.', setupFinish: 'Complete setup and enable member sign-in', setupPendingNote: 'Member sign-in is unavailable until setup is complete.', setupConflict: 'Setup changed elsewhere. Reload before continuing.', setupReload: 'Reload setup' });
    Object.assign(messages.zh, { directoryRecommended: '使用推荐目录', directoryRecommendedNote: '推荐：', directoryRecommendedCreate: '完成设置时自动创建，默认只读。' });
    Object.assign(messages.en, { directoryRecommended: 'Use recommended directory', directoryRecommendedNote: 'Recommended:', directoryRecommendedCreate: 'Created when setup completes, with read-only grants by default.' });
    Object.assign(messages.zh, { batchNote: '仅更新勾选的权限，其余设置保留。', batchTemplate: '权限模板：', batchMembers: '查看所选账号', batchScopeModels: '更新模型权限', batchScopeCapabilities: '更新能力权限', batchScopeDirectories: '更新目录权限' });
    Object.assign(messages.en, { batchNote: 'Only checked permissions are updated. Other settings stay as they are.', batchTemplate: 'Permission template:', batchMembers: 'View selected accounts', batchScopeModels: 'Update model permissions', batchScopeCapabilities: 'Update capability permissions', batchScopeDirectories: 'Update directory permissions' });
    Object.assign(messages.zh, { batchPage: '全选当前筛选的全部账号', batchLimit: '全选包含当前筛选的所有账号。', batchSelecting: '正在选择全部账号…', batchMore: '其余账号', batchConflict: '部分账号已变更，本次未保存。请重新选择。' });
    Object.assign(messages.en, { batchPage: 'Select every account matching this filter', batchLimit: 'Select all includes every account matching this filter.', batchSelecting: 'Selecting all accounts…', batchMore: 'other accounts', batchConflict: 'Some accounts changed. Nothing was saved. Select the accounts again.' });
    Object.assign(messages.zh, { contentPreviewReadOnly: '会话只读预览；文件可通过右键菜单管理。' });
    Object.assign(messages.en, { contentPreviewReadOnly: 'Read-only conversation preview. Manage files from their context menu.' });
    const styles = `
.lanw-navigation-group{display:flex;flex-direction:column;gap:3px}.lanw-navigation-group+.lanw-navigation-group{margin-top:18px}.lanw .lanw-navigation-group-title{margin:0 12px 4px;font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.lanw-sharing-tabs{display:flex;gap:24px;flex:none;max-width:100%;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-sharing-tabs>.lanw-btn{flex:none;white-space:nowrap}.lanw-sharing-panel[hidden]{display:none!important}.lanw .lanw-sharing-panel>:is(.lanw-card,.lanw-inline-execution,[data-home-directory]){margin-top:0;padding-top:0;border-top:0}.lanw .lanw-sharing-panel>:is(.lanw-card,.lanw-inline-execution,[data-home-directory])>:first-child{margin-top:0}@media(max-width:600px){.lanw-sharing-tabs{gap:20px}}
.lanw-execution-overflow[popover]{position:fixed;inset:auto;margin:0;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}.lanw .lanw-execution-overflow>.lanw-btn{display:block;width:100%;min-height:34px;padding:8px 10px;border:0;border-radius:6px;background:transparent;text-align:left;white-space:nowrap;font-size:12px;font-weight:400}.lanw .lanw-execution-overflow>.lanw-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.lanw-execution-more{position:relative}.lanw-inline-execution{display:flex;flex-direction:column;gap:16px;min-width:0}.lanw-execution-sectionbar{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}.lanw .lanw-inline-execution .lanw-execution-tabs>.lanw-btn{min-height:34px;font-size:12px}
.lanw .lanw-inline-execution .lanw-stack{gap:14px}.lanw .lanw-execution-toolbar>input[type=search]{width:auto}
.lanw-inline-execution .lanw-execution-tabs{display:flex;flex:none;gap:20px;min-width:0;overflow-x:auto}.lanw .lanw-execution-tabs>.lanw-btn{position:relative;min-height:43px;padding:0 2px;border:0;border-radius:6px;background:transparent;box-shadow:none;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;transition:color .16s ease}.lanw .lanw-execution-tabs>.lanw-btn[aria-selected=true]{color:var(--dsw-alias-label-primary)}.lanw-execution-tabs>.lanw-btn[aria-selected=true]::after{position:absolute;right:0;bottom:0;left:0;height:2px;border-radius:999px;background:currentColor;content:''}.lanw-execution-panel[hidden]{display:none!important}.lanw-inline-execution .lanw-help{margin:0}.lanw-inline-execution .lanw-execution-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.lanw-execution-toolbar>input[type=search]{flex:1;min-width:180px;width:auto}.lanw-execution-toolbar>.lanw-execution-more{margin-left:auto}.lanw-execution-toolbar>input[type=search]~.lanw-execution-more{margin-left:0}.lanw-inline-execution .lanw-execution-tool{min-height:52px}.lanw-inline-execution .lanw-cli-card{padding:12px 0}.lanw-cli-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px}.lanw-cli-meta .lanw-cli-path{min-width:0;overflow-wrap:anywhere}.lanw-inline-execution [data-tool-pagination]{margin-top:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}@media(max-width:600px){.lanw-execution-toolbar>input[type=search]{flex-basis:100%}}
.lanw .lanw-execution-tabs>.lanw-btn:hover:not(:disabled),.lanw .lanw-execution-tabs>.lanw-btn:active:not(:disabled){background:transparent;color:var(--dsw-alias-label-primary)}@media(prefers-reduced-motion:reduce){.lanw .lanw-execution-tabs>.lanw-btn{transition:none}}
.lanw .lanw-editdialog:is(.lanw-execution-source-editor,.lanw-execution-sources-dialog)[data-edit-dialog]{height:fit-content;min-height:0}
.lanw-execution-source-row{display:flex;align-items:center;gap:8px;min-height:64px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-execution-source-actions{display:flex;align-items:center;align-self:center;gap:8px;flex:none}.lanw .lanw-execution-source-actions>.lanw-btn{align-self:center}.lanw-execution-source-summary{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.lanw-execution-source-summary>strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lanw-execution-source-summary>.lanw-help{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lanw-execution-source-count{flex:none;font-size:12px;white-space:nowrap}.lanw .lanw-editdialog.lanw-execution-source-editor[data-edit-dialog]{width:min(600px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px)}.lanw .lanw-execution-source-editor .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px 0;border-bottom:0}.lanw-execution-source-editor .lanw-field input{width:100%;min-width:0}@media(max-width:560px){.lanw-execution-source-count{display:none}}
.lanw-execution-operations>.lanw-execution-operation{padding:0}.lanw-execution-operation-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px}.lanw .lanw-execution-operation-row>.lanw-btn{align-self:center;flex:none}.lanw-execution-operation-row>.lanw-check{min-width:0;overflow-wrap:anywhere}.lanw-execution-operation-details{padding:4px 0 12px 28px}
.lanw-execution-tool{display:flex;align-items:center;gap:12px;min-height:49px;padding:8px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-execution-tool>.lanw-btn{align-self:center}.lanw-execution-tool-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500}.lanw-execution-tool-state{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 10px;max-width:45%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw-execution-tool-state>span{white-space:nowrap}.lanw .lanw-editdialog:is(.lanw-execution-dialog,.lanw-execution-sources-dialog)[data-edit-dialog]{width:min(680px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px)}.lanw .lanw-execution-actions>.lanw-execution-source-button{margin-left:auto}.lanw .lanw-execution-sources-dialog .lanw-cli-card{padding:0 0 16px}.lanw-execution-dialog-content{min-width:0}.lanw-execution-dialog-content>p{overflow-wrap:anywhere}
.lanw-execution-actions{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base);padding:8px 0}.lanw-execution-runtime>summary{color:var(--dsw-alias-label-secondary);font-size:12px}.lanw-execution-runtime>div{margin-top:12px}
.lanw-execution-actions{flex-wrap:wrap}.lanw-execution-catalog input[type=search]{width:100%;padding:7px 10px;font:inherit;font-size:13px}.lanw-execution-catalog details>summary{cursor:pointer;font-size:13px;font-weight:500}.lanw-execution-sources>fieldset,.lanw-execution-usage>div{margin-top:16px}.lanw-execution-grants{display:flex;flex-wrap:wrap;gap:12px 24px}.lanw-execution-operation{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-execution-parameters{display:grid;grid-template-columns:minmax(65px,auto) minmax(0,1fr);gap:6px 12px;margin:0;font-size:12px;line-height:19px}.lanw-execution-parameters dt{font-family:monospace;overflow-wrap:anywhere}.lanw-execution-parameters dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.lanw-execution-usage code{display:block;white-space:normal;overflow-wrap:anywhere;font-size:12px}.lanw-execution-catalog .lanw-cli-card{padding:16px 0}
.lanw-cli-manager .lanw-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:36px}.lanw-cli-manager :is(.lanw-cli-pair,.lanw-cli-argument)>input{padding:7px 10px;font:inherit;font-size:13px}
.lanw-cli-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.lanw-cli-card{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-cli-summary{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;overflow-wrap:anywhere}.lanw-cli-summary code{font-size:12px;color:var(--dsw-alias-label-secondary)}.lanw-cli-path{overflow-wrap:anywhere}.lanw-cli-argument,.lanw-cli-pair{display:flex;gap:8px;min-width:0}.lanw-cli-argument>input,.lanw-cli-pair>input{flex:1;min-width:0}.lanw .lanw-cli-add-row{align-self:flex-start}.lanw-cli-advanced>summary{cursor:pointer;font-size:13px}.lanw-cli-advanced>div{margin-top:16px}.lanw-cli-manager form>.lanw-fieldset{gap:20px}.lanw-cli-manager .lanw-error{overflow-wrap:anywhere}.lanw-cli-manager textarea{resize:vertical}@media(max-width:600px){.lanw-cli-grid{grid-template-columns:minmax(0,1fr)}.lanw-cli-pair{flex-wrap:wrap}.lanw-cli-pair>input{flex-basis:calc(50% - 8px)}}
.lanw .lanw-batch-recipients{max-height:128px;overflow:auto;padding:2px}.lanw-batch-recipients .lanw-badge{max-width:100%;overflow-wrap:anywhere;white-space:normal}.lanw-batch-selection>summary,.lanw-batch-template>summary{font-size:13px;color:var(--dsw-alias-label-secondary)}
.lanw.lanw-setup-shell{height:100%;max-height:100%;min-height:0;padding:0;overflow:hidden;align-items:stretch}.lanw-setup-shell .lanw-setup-guide{display:flex;flex:1;min-height:0;height:100%;max-height:100%}.lanw-setup-guide form{display:flex;flex:1;min-height:0}.lanw-setup-guide form>.lanw-fieldset{display:flex;flex:1;min-height:0;flex-direction:column;gap:0}.lanw-setup-guide [data-setup-step]{flex:1;min-height:0;overflow:auto;padding:8px 2px 16px}.lanw-setup-guide .lanw-setup-actions{flex:none;position:sticky;bottom:0;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}.lanw-directory-recommendation{display:flex;flex-wrap:wrap;align-items:center;gap:8px;overflow-wrap:anywhere}
.lanw-first-steps{list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:0;margin:0 0 20px}.lanw-first-steps li{padding:8px 0;border-bottom:2px solid var(--dsw-alias-border-l1);font-size:12px;min-width:0}.lanw-first-steps li[aria-current=step]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}@media(max-width:620px){.lanw-first-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
.lanw .lanw-setup-guide{max-width:760px;margin:0 auto;padding:24px}.lanw-setup-guide .lanw-setup-progress{margin-bottom:12px}.lanw-setup-guide .lanw-setup-progress li{flex:1;min-width:0}.lanw-setup-guide code{display:block;overflow-wrap:anywhere;white-space:normal;padding:12px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}.lanw-setup-actions{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:16px}
.lanw .lanw-accountlist .lanw-account-table th:first-child{width:36px}.lanw .lanw-accountlist .lanw-account-table th:nth-child(2){width:auto}.lanw .lanw-accountlist .lanw-account-table th:nth-child(3){width:14%}.lanw .lanw-accountlist .lanw-account-table th:nth-child(4){width:15%}.lanw .lanw-accountlist .lanw-account-table th:nth-child(5){width:20%}.lanw .lanw-accountlist .lanw-account-table .lanw-selection-cell{padding:8px}.lanw .lanw-accountlist .lanw-account-table tr[aria-selected=true] td{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}
.lanw-batchbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0}.lanw-batch-recipients{display:flex;gap:6px;flex-wrap:wrap;max-height:96px;overflow:auto}.lanw .lanw-selection-cell{width:36px;min-width:36px;padding:8px}.lanw-selection-cell input{width:16px;height:16px;margin:0}.lanw-batch-scope{margin-bottom:16px}
.lanw .lanw-editdialog.lanw-account-operation-dialog[data-edit-dialog]{width:min(480px,calc(100vw - 32px));height:fit-content;min-height:0;max-height:calc(100dvh - 48px)}.lanw-account-operation-dialog .lanw-edit-layout{min-height:0}.lanw-account-operation-dialog .lanw-edit-body{min-height:0}.lanw .lanw-delete-account{color:var(--dsw-alias-state-error-primary)}.lanw-sidebar-file-menu{display:contents}
.lanw{box-sizing:border-box;width:100%;max-width:100%;min-height:0;min-width:0;contain:inline-size;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 0 24px;overflow-x:clip;scrollbar-gutter:stable both-edges;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.lanw>*{width:100%;max-width:960px;flex-shrink:0}.lanw *{box-sizing:border-box}.lanw [hidden]{display:none!important}.lanw h1,.lanw h2,.lanw h3,.lanw p{margin:0}.lanw h1{font-size:20px;font-weight:500;line-height:28px}.lanw h2,.lanw h3{font-size:14px;font-weight:500;line-height:22px}.lanw-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:0}.lanw-heading{min-width:0;max-width:100%}.lanw-header .lanw-help{margin:4px 0 0}.lanw-headeractions{display:flex;align-items:center;gap:8px;flex:none}.lanw-title-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.lanw a{color:var(--dsw-alias-label-primary);text-decoration:none}.lanw a:hover{text-decoration:underline}.lanw-help,.lanw-muted{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.lanw-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.lanw-spread{justify-content:space-between}.lanw-stack{display:flex;flex-direction:column;gap:16px;min-width:0}.lanw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}.lanw-boundary{padding:0;color:var(--dsw-alias-label-secondary)}.lanw-boundary strong{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}.lanw-boundary details{margin-top:8px;font-size:12px;line-height:18px}.lanw details>summary{cursor:pointer}.lanw details>div{margin-top:12px}.lanw details p+p{margin-top:8px}.lanw-layout{display:flex;flex-direction:column;gap:32px;min-width:0}.lanw-nav{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;min-width:0}.lanw-navlist{display:flex;flex-wrap:nowrap;gap:4px;min-width:0;overflow-x:auto}.lanw-user{display:inline-flex;align-items:center;flex-wrap:nowrap;gap:8px;min-width:0;max-width:100%;min-height:38px;padding:3px 6px 3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));white-space:nowrap;box-shadow:none}.lanw-user-info{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden}.lanw-user strong{min-width:0;max-width:144px;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:500}.lanw-user .lanw-help{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:18px}.lanw-user-divider{height:14px;width:1px;flex:0 0 1px;background:var(--dsw-alias-border-l1)}.lanw .lanw-user .lanw-btn{flex-shrink:0;min-height:28px;height:28px;padding:0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}.lanw-content{padding:0;min-width:0}.lanw-projects{gap:8px}.lanw-projectlist{display:flex;flex-wrap:wrap;gap:4px;max-height:160px;overflow:auto}.lanw .lanw-projectbtn{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lanw-card{padding:0;border:0;background:transparent;min-width:0}.lanw-card>h2,.lanw-card>h3{margin-bottom:8px}.lanw-card>.lanw-help{margin-bottom:12px}.lanw-form,.lanw-fieldset{display:flex;flex-direction:column;gap:14px;min-width:0}.lanw-fieldset{margin:0;padding:0;border:0}.lanw-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw .lanw-field input,.lanw .lanw-field select,.lanw .lanw-field textarea{display:block;width:100%;max-width:100%;min-width:0;margin:0;padding:7px 10px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}.lanw .lanw-field input,.lanw .lanw-field select{height:36px;min-height:36px}.lanw .lanw-field textarea{min-height:82px;resize:vertical}.lanw .lanw-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-primary)}.lanw .lanw-check input{display:inline-block;width:15px;height:15px;min-height:0;flex:0 0 15px;margin:2px 0 0;padding:0;accent-color:var(--dsw-alias-brand-primary)}.lanw-checks{display:grid;gap:8px}
.lanw button,.lanw input,.lanw select,.lanw textarea,.lanw summary{outline-offset:3px}.lanw button:focus-visible,.lanw input:focus-visible,.lanw select:focus-visible,.lanw textarea:focus-visible,.lanw summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.lanw .lanw-btn{display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;flex:0 0 auto;width:auto;max-width:100%;height:32px;min-height:32px;margin:0;padding:0 12px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-decoration:none;white-space:nowrap;box-shadow:none;cursor:pointer;transition:background .12s}.lanw .lanw-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw .lanw-btn:disabled{opacity:.5;cursor:not-allowed}.lanw .lanw-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}.lanw .lanw-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.88}.lanw .lanw-iconbutton{width:28px;height:28px;min-height:28px;padding:0;border-radius:8px}.lanw .lanw-navbtn{color:var(--dsw-alias-label-secondary)}.lanw .lanw-navbtn[aria-current="page"],.lanw .lanw-projectbtn[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.lanw-tabs{display:inline-flex;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;gap:4px;align-self:flex-start;width:max-content;min-width:0;max-width:100%;padding:4px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw-tabs .lanw-btn{width:auto;flex:none;min-width:0;height:auto;min-height:32px;padding:6px 16px;white-space:nowrap;border:1px solid transparent;border-radius:12px;color:var(--dsw-alias-label-secondary);font-weight:500}.lanw-tabs .lanw-btn[aria-selected="true"]{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}.lanw-adminpanel[hidden]{display:none!important}.lanw-toolbar{display:flex;flex-wrap:wrap;align-items:end;justify-content:space-between;gap:12px}.lanw-toolbar>.lanw-field{flex:1 1 210px;max-width:320px}.lanw-accountlayout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}.lanw-accountlayout.has-panel{grid-template-columns:minmax(0,1fr) minmax(280px,440px)}.lanw-accountlist{min-width:0;border:0;background:transparent}.lanw-tablewrap{width:100%;max-width:100%;overflow:auto}.lanw table{width:100%;border-collapse:separate;border-spacing:0 2px;text-align:left;font-variant-numeric:tabular-nums}.lanw th{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}.lanw th,.lanw td{padding:6px 12px;white-space:nowrap}.lanw-accountlist tbody tr{height:72px}.lanw-accountlist tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw-accountlist tbody td:first-child{border-radius:16px 0 0 16px}.lanw-accountlist tbody td:last-child{border-radius:0 16px 16px 0}.lanw-accountname{font-size:14px;font-weight:500;line-height:20px}.lanw-accountname small{display:block;margin-top:4px;font-size:13px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-secondary)}.lanw-badge{display:inline-block;padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}.lanw-status{display:inline-flex;gap:6px;align-items:center;font-size:12px}.lanw-status:before{content:'';width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}.lanw-status.is-disabled:before{background:var(--dsw-alias-state-idle-primary)}
.lanw-actionpanel{max-width:440px;width:100%;min-width:0;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1)}.lanw-panelhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.lanw-panelhead h2{min-width:0;overflow-wrap:anywhere}.lanw-danger{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-danger>summary,.lanw-danger .lanw-btn{color:var(--dsw-alias-state-error-primary)}.lanw-resource-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px;align-items:start;min-width:0}.lanw .lanw-resource-card{display:flex;flex-direction:column;gap:12px;min-width:0;margin:0;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base)}.lanw .lanw-resource-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--dsw-alias-bg-base))}.lanw-resource-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}.lanw-resource-head .lanw-check,.lanw .lanw-resource-title{flex:1;min-width:0;font-size:12px;font-weight:500;line-height:18px;overflow-wrap:anywhere}.lanw-resource-head .lanw-check input{margin-top:2px;width:13px;height:13px;flex-basis:13px}.lanw-resource-status{flex:none;font-size:10px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.lanw-resource-status.is-shared{color:var(--dsw-alias-state-success-primary)}.lanw-resource-status.is-unavailable{color:var(--dsw-alias-state-warn-primary)}.lanw .lanw-resource-description{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;height:54px;min-height:54px;margin:0;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw .lanw-resource-description[data-expanded=true]{display:block;-webkit-line-clamp:unset;height:auto;overflow:visible}.lanw .lanw-resource-reason{font-size:11px;line-height:18px;color:var(--dsw-alias-state-warn-primary);margin:0;overflow-wrap:anywhere}.lanw-resource-footer{display:flex;justify-content:flex-end;min-height:24px}.lanw .lanw-resource-footer .lanw-btn{height:24px;min-height:24px;padding:0 6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw [data-model-catalog]>summary,.lanw [data-startup-environment]>summary{font-size:13px;font-weight:500;line-height:20px}.lanw-browsertools{display:flex;flex-wrap:wrap;gap:12px;align-items:end}.lanw-browsertools>.lanw-field:first-child{flex:1 1 180px}.lanw-browsertools>.lanw-field:last-child{flex:0 0 110px}.lanw-pager{justify-content:flex-end}.lanw-pager [role="status"]{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lanw-model-browser{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:12px;line-height:18px}.lanw-model-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.lanw .lanw-model-tools input,.lanw .lanw-model-tools select{box-sizing:border-box;min-width:0;height:30px;margin:0;padding:4px 8px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}.lanw-model-tools>input{flex:1 1 160px;width:0}.lanw-model-size{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.lanw .lanw-model-size select{width:52px}.lanw-model-list{min-width:0}.lanw-model-provider{padding:10px 8px 4px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.lanw-model-browser [data-model-row]{margin:0;padding:0;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;min-height:36px;background:transparent}.lanw-model-browser [data-model-row]>summary{display:flex;align-items:center;gap:8px;min-height:36px;margin:0;padding:7px 8px;list-style:none;cursor:pointer;font-size:12px;font-weight:400;line-height:20px;border-radius:6px}.lanw-model-browser [data-model-row]>summary::-webkit-details-marker{font-size:0}.lanw-model-browser [data-model-row]>summary:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw-model-chevron{flex:none;color:var(--dsw-alias-label-secondary)}.lanw [data-model-row][open]>summary>.lanw-model-chevron{transform:rotate(90deg)}.lanw-model-name{min-width:0;flex:1;overflow-wrap:anywhere}.lanw-model-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}.lanw-model-browser .lanw-model-efforts{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:2px 8px 10px 28px}.lanw .lanw-model-efforts .lanw-check,.lanw-model-effort{display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px;font-weight:400;line-height:18px;background:var(--dsw-alias-bg-base)}.lanw-model-efforts .lanw-check:has(input:checked){border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw .lanw-model-efforts .lanw-check input{width:12px;height:12px;flex:0 0 12px;margin:0}.lanw-model-footer{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw-model-footer .lanw-row{gap:4px}.lanw .lanw-model-footer .lanw-btn{height:26px;min-height:26px;padding:0 7px;font-size:11px;line-height:18px}.lanw-model-empty{padding:12px 8px;color:var(--dsw-alias-label-secondary)}.lanw [data-model-policy]>summary{font-size:12px;font-weight:500;line-height:20px}.lanw-actionpanel .lanw-panelhead h2{font-size:13px;line-height:20px}
.lanw-auth{width:100%;max-width:440px;align-self:center}.lanw-authswitch{display:flex;flex-wrap:nowrap;gap:4px;min-width:0;overflow-x:auto;margin-bottom:16px}.lanw-notice{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow-wrap:anywhere}.lanw-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.lanw-success{color:var(--dsw-alias-state-success-primary)}.lanw-empty{padding:24px 12px;color:var(--dsw-alias-label-secondary)}.lanw-terminal-status{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--dsw-alias-state-error-primary)}.lanw-code{font:12px/18px ui-monospace,monospace;max-width:100%;overflow-wrap:anywhere}.lanw-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;margin:12px 0 0}.lanw-dl dt{font-size:12px;color:var(--dsw-alias-label-secondary)}.lanw-dl dd{margin:0;overflow-wrap:anywhere}.lanw table caption{text-align:left;padding-bottom:10px;color:var(--dsw-alias-label-secondary);font-size:12px}.lanw-invite{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.lanw-editdialog{width:calc(100% - 48px);max-width:520px;max-height:calc(100% - 48px);margin:auto;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;overflow:auto}.lanw-editdialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.lanw-info-content{display:grid;gap:20px;margin-top:20px;font-size:13px;line-height:20px}.lanw-info-content section{display:grid;gap:6px}.lanw-info-content p,.lanw-info-content dl{color:var(--dsw-alias-label-secondary)}.lanw-info-content .lanw-dl{font-size:12px;margin:6px 0 0}.lanw-info-content dd{overflow-wrap:anywhere}
@media(max-width:1100px){.lanw-accountlayout.has-panel{grid-template-columns:minmax(0,1fr)}}
@media(max-width:620px){.lanw{padding:0 24px 32px}.lanw-grid{grid-template-columns:minmax(0,1fr)}.lanw-nav{align-items:flex-start}.lanw-user{flex-wrap:nowrap}.lanw-toolbar>.lanw-field{max-width:none;flex-basis:100%}.lanw-actionpanel{max-width:100%}.lanw-tabs{min-width:0;max-width:100%}.lanw-tabs .lanw-btn{padding:0 4px;font-size:12px}}
.lanw .lanw-headeractions{align-items:center;gap:4px}.lanw .lanw-iconbutton{width:32px;height:32px;padding:7px;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center}.lanw .lanw-iconbutton:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.lanw .lanw-iconbutton svg{width:18px;height:18px;flex:none}.lanw [data-refresh-account][aria-busy=true] svg{animation:lanw-refresh-spin 1s linear infinite}@keyframes lanw-refresh-spin{to{transform:rotate(360deg)}}
.lanw-editdialog[data-edit-dialog]{padding:0;width:min(720px,calc(100vw - 48px));max-width:calc(100vw - 48px);max-height:calc(100dvh - 64px);border:1px solid var(--dsw-alias-border-l1);border-radius:20px;overflow:hidden}.lanw-editdialog[data-edit-dialog][open]{display:flex;flex-direction:column}.lanw-editdialog[data-edit-dialog]>.lanw-panelhead{flex:none;padding:20px 24px;margin:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-editdialog[data-edit-dialog]>.lanw-panelhead h2{font-size:16px;line-height:24px;font-weight:500}.lanw-edit-body{min-height:0;overflow-y:auto;padding:24px;overscroll-behavior:contain}.lanw-edit-body .lanw-stack{gap:20px}.lanw-edit-body>.lanw-stack>.lanw-help{margin:0}.lanw-edit-footer{flex:none;display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}.lanw-edit-footer .lanw-btn{min-height:36px;padding:8px 16px}.lanw-permission-groups{display:flex;flex-direction:column;gap:0}.lanw-policy{min-width:0;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;padding:0;background:transparent}.lanw-policy[open],.lanw-policy[data-capability-policy],.lanw-policy[data-directory-policy]{grid-column:1/-1}.lanw-policy>summary{display:flex;align-items:center;gap:10px;list-style:none;padding:14px 0;font-size:14px;line-height:20px;cursor:pointer}.lanw-policy>summary::-webkit-details-marker{display:none}.lanw-policy>summary:before{content:'';width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s}.lanw-policy[open]>summary:before{transform:rotate(45deg)}.lanw-policy-state{margin-left:auto;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:400}.lanw-policy>div{padding:0 0 16px}.lanw-policy>div>.lanw-field{margin-top:4px}.lanw-capability-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px}.lanw-edit-status{margin-top:6px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-edit-status .lanw-help{margin:8px 0 0;font-size:12px}.lanw-edit-body .lanw-danger{margin-top:10px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.lanw .lanw-account-filters,.lanw .lanw-account-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px}.lanw .lanw-account-filters .lanw-row{gap:2px}.lanw .lanw-account-filters button{font-size:13px;min-height:30px;padding:5px 11px;border:0}.lanw .lanw-account-filters button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);font-weight:500}.lanw .lanw-accountlist th{font-weight:400;font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 12px}.lanw .lanw-accountlist tbody td{padding:12px}.lanw .lanw-accountlist tbody tr{cursor:pointer;outline:none}.lanw .lanw-accountlist tbody tr:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l1)}.lanw .lanw-accountname{font-size:14px;line-height:20px}.lanw .lanw-accountname small{margin-top:2px;font-size:12px;line-height:18px}.lanw .lanw-access-summary{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.lanw .lanw-account-pagination{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw .lanw-account-pagination .lanw-pager{margin:0;gap:12px}.lanw .lanw-account-pagination select{min-height:30px;padding:4px 24px 4px 8px;width:auto}
.lanw-info-dialog{width:min(600px,calc(100vw - 48px));max-height:calc(100dvh - 64px);padding:24px;border-radius:20px}.lanw-info-dialog h2{font-size:18px;line-height:26px;font-weight:600}.lanw-info-dialog .lanw-info-content{gap:0}.lanw-info-intro{margin:18px 0 4px;font-size:14px;color:var(--dsw-alias-label-secondary)}.lanw-info-content section{padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-info-content section:last-child{border:0;padding-bottom:0}.lanw-info-content h3{font-size:14px;font-weight:500;line-height:22px;margin:0 0 8px}.lanw-info-content p{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary);margin:0 0 10px}.lanw-info-content .lanw-badge{font-size:11px;font-weight:400}.lanw-info-content .lanw-entry-link{display:block;overflow-wrap:anywhere;font-size:13px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-decoration:none}.lanw-info-content .lanw-btn{font-size:13px;padding:6px 10px;min-height:30px}
@media(max-width:640px){.lanw-editdialog[data-edit-dialog],.lanw-info-dialog{width:calc(100vw - 24px);max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);border-radius:16px}.lanw-edit-body{padding:16px}.lanw-editdialog[data-edit-dialog]>.lanw-panelhead,.lanw-edit-footer{padding:14px 16px}.lanw-permission-groups{grid-template-columns:1fr}.lanw-capability-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.lanw .lanw-account-pagination{align-items:flex-start;flex-wrap:wrap}.lanw .lanw-accountlist table{min-width:600px}.lanw-policy-state{font-size:11px}}
.lanw .lanw-btn-secondary{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid transparent;border-radius:8px;padding:8px 14px;min-height:34px}.lanw .lanw-btn-secondary:hover{background:var(--dsw-alias-bg-layer-2)}.lanw-heading .lanw-help{font-size:13px}.lanw-card>h2{margin-bottom:12px}.lanw-card>.lanw-help{max-width:60ch;line-height:1.65}.lanw .lanw-sharing-summary{width:100%;max-width:none;grid-template-columns:minmax(0,1fr) auto;gap:0;margin:16px 0 20px}.lanw-sharing-summary dt,.lanw-sharing-summary dd{padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}.lanw-sharing-summary dd{min-width:40px;text-align:right;font-variant-numeric:tabular-nums}.lanw [data-home-directory]{padding-top:24px;border-top:1px solid var(--dsw-alias-border-l1)}
.lanw-edit-heading{min-width:0}.lanw-edit-heading .lanw-help{margin-top:4px;font-size:12px;line-height:18px;overflow-wrap:anywhere}.lanw .lanw-access-section{min-width:0}.lanw-edit-body .lanw-access-section>h3{font-size:14px;line-height:22px;font-weight:500;margin:0 0 4px}.lanw-edit-body .lanw-help{font-size:12px;line-height:19px}.lanw-edit-body .lanw-field>span{font-size:12px}.lanw-edit-body form>.lanw-fieldset{display:flex;flex-direction:column;gap:24px}.lanw .lanw-policy>div{margin-top:0}.lanw [data-capability-policy]>summary{font-weight:500}.lanw-permission-groups .lanw-policy:last-child{border-bottom:0}.lanw .lanw-access-section>.lanw-permission-groups{margin-top:4px}.lanw-edit-body [data-model-policy]{border:0;padding:0}.lanw-edit-body [data-model-policy]>summary{padding:4px 0;font-size:13px;font-weight:400}.lanw-edit-body .lanw-edit-status{margin-top:0}.lanw-edit-body .lanw-danger{margin-top:4px}.lanw-edit-body .lanw-danger>summary{font-size:13px}.lanw-edit-footer{gap:12px}.lanw-edit-footer .lanw-btn:not(.lanw-btn-primary){color:var(--dsw-alias-label-secondary)}
.lanw .lanw-editdialog[data-edit-dialog]{width:min(800px,calc(100vw - 48px));height:min(680px,calc(100dvh - 64px))}.lanw-edit-layout{display:flex;flex:1;min-height:0;overflow:hidden}.lanw-access-nav{flex:0 0 164px;padding:16px 10px;background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto}.lanw .lanw-access-nav .lanw-btn{display:block;text-align:left;width:100%;font-size:13px;line-height:20px;min-height:36px;padding:8px 12px;border:0;border-radius:7px;background:transparent;font-weight:400;margin-bottom:3px}.lanw .lanw-access-nav .lanw-btn[aria-current=page]{background:var(--dsw-alias-bg-base);font-weight:500}.lanw .lanw-access-nav .lanw-btn:hover{background:var(--dsw-alias-bg-layer-2)}.lanw-edit-layout>.lanw-edit-body{flex:1;min-width:0;padding:24px}.lanw .lanw-policy-pane>h3{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500;line-height:22px;margin:0 0 20px}.lanw .lanw-policy-pane>.lanw-stack{gap:16px}.lanw .lanw-policy-pane{padding:0;border:0;margin:0}.lanw .lanw-policy-pane>.lanw-help{margin-top:12px}.lanw .lanw-policy-pane>.lanw-help:first-child{margin-top:0}.lanw-edit-layout .lanw-capability-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 12px}.lanw-edit-body [data-access-panel]>section>.lanw-help{font-size:12px}.lanw .lanw-policy{border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent}.lanw .lanw-policy>summary{padding:14px 0}.lanw .lanw-policy>div{padding:0 0 16px}.lanw-edit-layout .lanw-access-section{gap:16px}
@media(max-width:620px){.lanw .lanw-editdialog[data-edit-dialog]{width:calc(100vw - 24px);height:calc(100dvh - 24px);max-height:calc(100dvh - 24px)}.lanw-edit-layout{flex-direction:column}.lanw-access-nav{flex:0 0 auto;display:flex;gap:4px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px}.lanw .lanw-access-nav .lanw-btn{flex:none;width:auto;white-space:nowrap;margin:0}.lanw-edit-layout>.lanw-edit-body{padding:20px 16px}}
.lanw input:not([type=checkbox]):not([type=radio]):focus-visible,.lanw select:focus-visible,.lanw textarea:focus-visible{outline-offset:-2px}
.lanw-capability-tabs{max-width:100%;width:fit-content;overflow-x:auto;flex-wrap:nowrap}.lanw .lanw-capability-tabs .lanw-btn[aria-current=page]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.lanw .lanw-personal [data-personal-panel=features]{gap:0}.lanw .lanw-capability-settings .lanw-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:44px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:22px}.lanw-capability-settings .lanw-setting-row .lanw-help{margin-top:4px}.lanw-capability-resources{max-height:320px;overflow-y:auto;overscroll-behavior:contain;gap:4px}.lanw .lanw-capability-resources>.lanw-check{min-height:40px;padding:9px 12px;border:1px solid transparent;border-radius:8px;font-size:14px;line-height:20px}.lanw .lanw-capability-resources>.lanw-check:hover:not(:has(input:disabled)){background:var(--dsw-alias-interactive-bg-hover)}.lanw .lanw-capability-resources>.lanw-check:has(input:checked){border-color:var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}.lanw-personal-footer{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.lanw .lanw-access-group{display:flex;flex-direction:column;gap:2px}.lanw .lanw-access-group+.lanw-access-group{margin-top:14px}.lanw .lanw-access-group-title{margin:0 12px 6px;font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary)}.lanw .lanw-access-group .lanw-btn{min-height:36px;padding:7px 12px;margin-bottom:0}@media(max-width:640px){.lanw .lanw-access-group{flex:none;flex-direction:row;align-items:center;gap:2px}.lanw .lanw-access-group+.lanw-access-group{margin:0 0 0 8px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1)}.lanw .lanw-access-group-title{display:none}}
.lanw .lanw-check{align-items:center;gap:10px;cursor:pointer}.lanw .lanw-check input[type=checkbox]{appearance:none;position:relative;display:inline-block;flex:0 0 16px;width:16px;height:16px;min-height:16px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-base);cursor:inherit;transition:background .12s,border-color .12s}.lanw .lanw-check:hover input:not(:disabled){border-color:var(--dsw-alias-label-secondary)}.lanw .lanw-check input:checked{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}.lanw .lanw-check input:checked:after{content:'';position:absolute;left:5px;top:2px;width:4px;height:8px;border:solid var(--dsw-alias-bg-base);border-width:0 2px 2px 0;transform:rotate(45deg)}.lanw .lanw-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.lanw .lanw-check:has(input:disabled){opacity:.45;cursor:default}.lanw-edit-layout .lanw-policy-pane .lanw-fieldset{gap:4px}.lanw-edit-layout .lanw-policy-pane .lanw-fieldset>.lanw-check{min-height:40px;padding:9px 12px;border:1px solid transparent;border-radius:8px;font-size:14px;line-height:20px}.lanw-edit-layout .lanw-policy-pane .lanw-fieldset>.lanw-check:hover:not(:has(input:disabled)){background:var(--dsw-alias-interactive-bg-hover)}.lanw-edit-layout .lanw-policy-pane .lanw-fieldset>.lanw-check:has(input:checked){border-color:var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}@media(prefers-reduced-motion:reduce){.lanw .lanw-check input[type=checkbox]{transition:none}}
.lanw-edit-layout .lanw-field,.lanw-page-main .lanw-form>.lanw-fieldset>.lanw-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,280px);align-items:center;gap:24px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}.lanw .lanw-edit-layout .lanw-field>span{font-size:14px;line-height:22px}.lanw .lanw-field-description{display:block;margin-top:4px;font-size:12px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-secondary)}.lanw-edit-layout .lanw-field input,.lanw-edit-layout .lanw-field select,.lanw-page-main .lanw-form>.lanw-fieldset>.lanw-field input,.lanw-page-main .lanw-form>.lanw-fieldset>.lanw-field select{background:var(--dsw-alias-bg-layer-1);border-color:transparent}.lanw-edit-layout .lanw-capability-grid{display:flex;flex-direction:column;gap:0}.lanw-edit-layout .lanw-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:58px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:22px}.lanw-edit-layout .lanw-setting-row>span{min-width:0}.lanw-edit-layout form>.lanw-fieldset{gap:0}.lanw-edit-layout .lanw-field:last-child,.lanw-edit-layout .lanw-setting-row:last-child{border-bottom:0}.lanw.lanw--sidebar .lanw-secondary-item{min-height:40px;font-size:14px;line-height:22px}.lanw .lanw-access-nav .lanw-btn{font-size:14px;line-height:22px}.lanw-edit-layout .lanw-policy-summary{margin-bottom:4px}.lanw-edit-layout .lanw-policy-pane>.lanw-stack,.lanw-edit-layout .lanw-access-section{gap:12px}@media(max-width:640px){.lanw .lanw-access-nav{flex-basis:auto}.lanw-edit-layout .lanw-field,.lanw-page-main .lanw-form>.lanw-fieldset>.lanw-field{grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 0}.lanw-edit-layout .lanw-setting-row{padding:14px 0}.lanw-edit-layout .lanw-field input,.lanw-edit-layout .lanw-field select{width:100%}}
.lanw .lanw-btn-secondary{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}.lanw .lanw-btn-secondary:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,var(--dsw-alias-bg-base))}.lanw .lanw-access-nav{flex-basis:188px;background:var(--dsw-alias-bg-layer-2);border-right:0}.lanw .lanw-access-nav .lanw-btn[aria-current=page]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base));font-weight:400}.lanw-tabs .lanw-btn{padding:6px 16px}
.lanw .lanw-accountlist tbody tr{height:40px}.lanw .lanw-accountlist tbody td{padding:6px 12px;white-space:nowrap}.lanw .lanw-accountname{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px;white-space:nowrap}.lanw .lanw-account-displayname{max-width:180px;overflow:hidden;text-overflow:ellipsis}.lanw .lanw-accountname small{display:inline;max-width:180px;margin:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:20px}.lanw .lanw-accountlist td .lanw-btn{min-height:28px;padding:4px 8px;font-size:13px}.lanw .lanw-accountlist .lanw-badge,.lanw .lanw-accountlist .lanw-status,.lanw .lanw-accountlist .lanw-access-summary{font-size:12px;line-height:20px}
.lanw .lanw-accountlist table{table-layout:fixed}.lanw .lanw-accountlist th:first-child{width:40%}.lanw .lanw-accountlist th:nth-child(2){width:14%}.lanw .lanw-accountlist th:nth-child(3){width:13%}.lanw .lanw-accountlist th:nth-child(4){width:20%}.lanw .lanw-accountlist th:last-child{width:13%}.lanw .lanw-accountlist td{overflow:hidden;text-overflow:ellipsis}.lanw .lanw-account-displayname{flex:0 1 auto;min-width:0;max-width:55%}.lanw .lanw-accountname small{flex:1 1 0;min-width:0;max-width:none}
.lanw .lanw-branding{max-width:680px;gap:18px}.lanw .lanw-branding>h2{margin:0}.lanw .lanw-branding>p{margin-top:-8px}.lanw-brand-preview{display:flex;flex-direction:column;gap:18px;padding:20px 24px 28px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base))}.lanw-brand-preview>.lanw-help{font-size:11px}.lanw-brand-headline{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;font-size:24px;font-weight:500;line-height:32px;overflow-wrap:anywhere}.lanw-brand-headline>svg,.lanw-brand-headline>img{flex:none}.lanw-brand-headline>span{min-width:0;text-align:center}.lanw-branding .lanw-form .lanw-stack{gap:12px}.lanw-branding input[type=file]{height:auto;padding:8px;font-size:12px}.lanw-branding input::file-selector-button{font:inherit;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base));border:0;border-radius:6px;padding:6px 10px;margin-right:10px;cursor:pointer}.lanw-branding .lanw-fieldset>.lanw-help{font-size:12px;line-height:19px}.lanw-branding .lanw-fieldset>.lanw-row{margin-top:12px}
.lanw-brand-sidebar-preview{display:flex;align-items:center;gap:10px;min-height:28px}.lanw-brand-preview-divider{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-brand-name-fields{display:grid;grid-template-columns:3fr 2fr;gap:16px;min-width:0}@media(max-width:620px){.lanw-brand-name-fields{grid-template-columns:1fr}}
.lanw-brand-preview-badge{align-self:center;border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish);padding:0 6px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}
.lanw-content-manager{gap:12px}.lanw-content-scope{display:flex;align-items:center;gap:12px;min-width:0}.lanw .lanw-content-member{display:flex;flex-direction:row;align-items:center;gap:10px;flex:1;max-width:360px;min-width:0}.lanw-content-member>span{flex:none}.lanw .lanw-content-member select{flex:1;width:auto;min-width:0}.lanw-content-scope>.lanw-iconbutton{align-self:center;margin-left:auto;background:var(--dsw-alias-bg-layer-1)}
.lanw-content-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;min-width:0}.lanw-content-toolbar .lanw-tabs{align-self:center;margin:0}.lanw-content-file-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-left:auto;max-width:100%}.lanw-content-file-actions>.lanw-btn{align-self:center}.lanw-content-filters{align-items:flex-end}.lanw-content-filters>.lanw-field{flex:1;min-width:160px}.lanw-content-filters>.lanw-check{padding-bottom:8px}
.lanw-content-location{display:flex;align-items:center;gap:8px;min-width:0;min-height:40px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lanw-content-path{flex:1;min-width:0}.lanw-content-path ol{display:flex;align-items:center;flex-wrap:wrap;gap:0;list-style:none;margin:0;padding:0;min-width:0}.lanw-content-path li{display:inline-flex;align-items:center;min-width:0;max-width:100%}.lanw-content-path li+li:before{content:"/";flex:none;margin:0 4px;color:var(--dsw-alias-label-secondary);font-size:12px}.lanw-content-path li>.lanw-btn{max-width:180px;min-height:28px;height:28px;padding:0 6px;align-self:center;font-size:12px}.lanw-content-path li>.lanw-btn>span,.lanw-content-path [aria-current]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.lanw-content-path [aria-current]{max-width:240px;padding:4px 6px;font-size:12px;font-weight:500}.lanw .lanw-content-up{align-self:center;flex:none;min-height:28px;height:28px;padding:0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.lanw-content-table{table-layout:fixed}.lanw-content-table th:first-child{width:44%}.lanw-content-table th:last-child{width:64px}.lanw-content-table td{height:42px;padding:5px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lanw-content-table .lanw-btn{min-height:28px;height:28px;padding:0 6px;max-width:100%}.lanw-content-table .lanw-file-name{justify-content:flex-start;text-align:left}.lanw-file-name>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.lanw-content-progress{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border-radius:8px}.lanw-content-editor{min-height:300px!important;font-family:monospace!important;font-size:12px!important;tab-size:2}.lanw-content-messages{display:flex;flex-direction:column;gap:20px}.lanw-content-message{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.lanw-content-message[data-role=user]{background:var(--dsw-alias-bg-layer-2)}.lanw-content-message>small{display:block;color:var(--dsw-alias-label-secondary);margin-bottom:6px}.lanw-content-message pre{font:inherit;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.lanw-content-details{display:flex;flex-direction:column;gap:18px}.lanw-content-details>p{overflow-wrap:anywhere}.lanw-content-actions{display:flex;flex-wrap:wrap;gap:8px}.lanw-content-table small{display:block;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;font-size:11px}@media(max-width:620px){.lanw-content-table th:first-child{width:38%}.lanw-content-toolbar>.lanw-field{min-width:120px}.lanw-content-table td{padding:5px 6px}}
@media(prefers-reduced-motion:reduce){.lanw [data-refresh-account][aria-busy=true] svg{animation:none}.lanw-policy>summary:before{transition:none}}
.lanw-filter-search{flex:1;min-width:180px}.lanw .lanw-filter-button{align-self:flex-end;gap:7px;height:36px}.lanw-filter-count{display:inline-flex;justify-content:center;align-items:center;min-width:18px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:6px;background:var(--dsw-alias-bg-base);font-size:11px}.lanw-filter-summary{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}.lanw-filter-summary .lanw-btn{height:24px;min-height:24px;padding:0 6px;font-size:12px}.lanw-editdialog.lanw-filter-dialog{width:560px;max-height:min(720px,calc(100dvh - 48px))}.lanw-filter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px}.lanw-filter-wide{grid-column:1/-1}.lanw-filter-grid .lanw-field{min-width:0}.lanw-filter-dialog .lanw-edit-body{padding:20px 24px}.lanw-filter-dialog .lanw-edit-footer{flex-wrap:wrap}.lanw-filter-dialog .lanw-form{gap:20px}@media(max-width:480px){.lanw-filter-grid{grid-template-columns:minmax(0,1fr)}.lanw-filter-dialog .lanw-edit-body{padding:16px}.lanw-filter-wide{grid-column:auto}}
.lanw .lanw-editdialog.lanw-filter-dialog{width:560px;height:fit-content;min-height:0;max-width:calc(100vw - 32px);max-height:min(720px,calc(100dvh - 48px))}
.lanw .lanw-editdialog.lanw-content-action-dialog{width:420px;height:fit-content;min-height:0;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px)}.lanw-content-action-dialog .lanw-edit-heading{min-width:0}.lanw-content-action-dialog .lanw-help{overflow-wrap:anywhere}
.lanw-window-close{position:absolute;z-index:1;top:24px;right:24px;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary)}.lanw-window-close:hover{background:var(--dsw-alias-interactive-bg-hover)}.lanw-window-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.lanw-workspace-window{position:relative;width:min(800px,calc(100vw - 48px));max-width:none;height:min(800px,calc(100dvh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));max-height:none;padding:0;overflow:hidden}.lanw.lanw--sidebar{display:grid;grid-template-columns:188px minmax(0,1fr);align-items:stretch;gap:0;min-height:0;height:100%;padding:0}.lanw-secondary-nav{min-width:0;min-height:0;overflow-y:auto;padding:28px 12px;background:var(--dsw-alias-bg-layer-2)}.lanw .lanw-window-title{font-size:16px;font-weight:500;line-height:24px;margin:0 12px 18px}.lanw-secondary-nav nav{display:flex;flex-direction:column;gap:4px}.lanw .lanw-secondary-item{width:100%;min-height:38px;height:auto;justify-content:flex-start;text-align:left;padding:9px 12px;border-radius:9px;font-size:13px;line-height:20px;white-space:normal;color:var(--dsw-alias-label-secondary);background:transparent}.lanw .lanw-secondary-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.lanw .lanw-secondary-item[aria-current=page]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base));font-weight:400}.lanw-page-main{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:28px 32px 32px;scrollbar-gutter:stable}.lanw-page-heading{margin:0 0 20px}.lanw-page-main>.lanw-page-heading{margin-right:40px}.lanw .lanw-page-heading h1,.lanw .lanw-page-heading h2{font-size:20px;line-height:28px;font-weight:500}.lanw .lanw-page-heading>.lanw-help{margin:4px 0 0;font-size:13px;line-height:20px}.lanw .lanw-policy-summary{margin:0 0 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.lanw-page-main>.lanw-notice{margin-bottom:16px}.lanw-section-picker{display:none}.lanw--sidebar .lanw-content-manager>p.lanw-help:first-of-type{display:none}.lanw--sidebar .lanw-user{margin-top:20px}.lanw-page-main .lann-account{font:inherit;padding:0}@media(max-width:640px){.lanw-window-close{position:absolute;z-index:1;top:24px;right:24px;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary)}.lanw-window-close:hover{background:var(--dsw-alias-interactive-bg-hover)}.lanw-window-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.lanw-workspace-window{position:relative;width:calc(100vw - 48px);height:min(800px,calc(100dvh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))))}.lanw.lanw--sidebar{grid-template-columns:minmax(0,1fr)}.lanw-secondary-nav{display:none}.lanw-section-picker{display:block;margin-bottom:20px}.lanw-page-main{padding:20px}.lanw-page-main>.lanw-page-heading{margin-bottom:20px}}
.lanw input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.lanw .lanw-field select,.lanw .lanw-field textarea,.lanw .lanw-model-tools select,.lanw select{box-sizing:border-box;min-height:36px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 20%,var(--dsw-alias-bg-base));border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.lanw input:not([type=checkbox]):not([type=radio]):not([type=hidden]):hover:not(:disabled),.lanw select:hover:not(:disabled),.lanw textarea:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 40%,var(--dsw-alias-bg-base))}.lanw input::placeholder,.lanw textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}.lanw :is(input,select,textarea):disabled{opacity:.55;cursor:not-allowed}.lanw input[readonly],.lanw textarea[readonly]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}
.lanw .lanw-btn{border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 9%,var(--dsw-alias-bg-base));background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}.lanw .lanw-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary)}.lanw .lanw-btn-secondary{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}.lanw .lanw-secondary-item,.lanw .lanw-account-filters .lanw-btn,.lanw .lanw-pager .lanw-btn,.lanw .lanw-tabs .lanw-btn,.lanw .lanw-access-nav .lanw-btn,.lanw .lanw-content-path .lanw-btn,.lanw .lanw-file-name,.lanw .lanw-iconbutton{border-color:transparent;background:transparent}.lanw .lanw-tabs .lanw-btn:is([aria-current=page],[aria-selected=true]){background:var(--dsw-alias-bg-base)}.lanw .lanw-access-nav .lanw-btn[aria-current=page]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}.lanw .lanw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.lanw .lanw-btn:disabled{cursor:not-allowed}
.lanw .lanw-secondary-item,.lanw .lanw-account-filters .lanw-btn,.lanw .lanw-pager .lanw-btn{border:0}.lanw .lanw-secondary-item[aria-current=page],.lanw .lanw-account-filters .lanw-btn[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}
.lanw .lanw-secondary-nav .lanw-secondary-item,.lanw .lanw-access-nav .lanw-btn{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:40px;height:auto;padding:9px 16px 9px 12px;border:0;border-radius:var(--dsw-radius-md);font-family:inherit;font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
.lanw .lanw-secondary-nav .lanw-secondary-item:hover,.lanw .lanw-access-nav .lanw-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.lanw .lanw-authorization-dialog[data-edit-dialog]{height:min(800px,calc(100dvh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));max-height:none}
.lanw .lanw-secondary-nav .lanw-secondary-item,.lanw .lanw-access-nav .lanw-btn{justify-content:flex-start;text-align:left}
.lanw-nav-label{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;text-align:left}.lanw-nav-label>svg{flex:none;width:16px;height:16px}.lanw-nav-label>span{min-width:0;overflow-wrap:anywhere}
.lanw .lanw-capability-tabs{display:flex;flex-wrap:nowrap;width:100%;min-width:0;overflow-x:auto;scrollbar-width:thin}.lanw .lanw-capability-tabs .lanw-btn{flex:1 0 auto;padding:6px}.lanw .lanw-capability-tabs .lanw-nav-label{gap:6px;white-space:nowrap;flex-shrink:0}
.lanw-content-path [aria-current]{display:inline-flex;align-items:center}
.lanw .lanw-filter-dialog .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:0;border:0;min-width:0}.lanw .lanw-filter-dialog .lanw-field>span{font-size:13px;line-height:20px}.lanw .lanw-filter-dialog .lanw-field :is(input,select){width:100%;min-width:0;max-width:100%}
.lanw .lanw-secondary-nav .lanw-secondary-item[aria-current=page],.lanw .lanw-access-nav .lanw-btn[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active)}
.lanw .lanw-create-dialog[data-edit-dialog]{width:min(800px,calc(100vw - 48px));height:auto;max-height:min(760px,calc(100dvh - 64px))}
.lanw-setup-progress{flex:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;list-style:none;margin:0;padding:18px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-setup-progress li{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}.lanw-setup-number{display:flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;font-size:12px}.lanw-setup-progress li[aria-current=step],.lanw-setup-progress li[data-complete=true]{color:var(--dsw-alias-label-primary)}.lanw-setup-progress li[aria-current=step]{font-weight:500}.lanw-setup-progress li[aria-current=step] .lanw-setup-number,.lanw-setup-progress li[data-complete=true] .lanw-setup-number{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}.lanw-account-step>.lanw-help{margin:0}
@media(max-width:620px){.lanw-setup-progress{padding:16px;gap:12px}}
@media(max-width:620px){.lanw .lanw-create-dialog[data-edit-dialog]{width:calc(100vw - 24px);height:auto;max-height:calc(100dvh - 24px)}}
.lanw .lanw-account-wizard[data-edit-dialog]{height:fit-content;min-height:0}.lanw-account-wizard .lanw-setup-progress{display:flex;align-items:center;gap:12px;padding:16px 24px}.lanw-account-wizard .lanw-setup-progress li{gap:8px}.lanw-account-wizard .lanw-setup-progress li+li:before{content:'';display:block;width:48px;height:1px;margin-right:4px;background:var(--dsw-alias-border-l2)}.lanw-identity-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.lanw .lanw-account-identity .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:0;border:0}.lanw .lanw-account-identity .lanw-field>span{font-size:13px;line-height:20px}.lanw-identity-fields>.lanw-field:last-child{grid-column:1/-1}
@media(max-width:620px){.lanw-account-wizard .lanw-setup-progress{padding:14px 16px;gap:8px}.lanw-account-wizard .lanw-setup-progress li+li:before{width:24px;margin-right:0}.lanw-identity-fields{grid-template-columns:minmax(0,1fr);gap:16px}}
.lanw .lanw-account-wizard .lanw-edit-body{padding:18px 24px}.lanw .lanw-account-wizard [data-account-step="1"]{gap:14px}.lanw .lanw-account-wizard .lanw-model-policy-compact{gap:6px}.lanw .lanw-account-wizard .lanw-model-policy-compact>.lanw-field{padding:6px 0;border-bottom:0}.lanw .lanw-account-wizard [data-access-panel=capabilities]{position:relative}.lanw .lanw-account-wizard [data-access-panel=capabilities]>h3{font-size:14px;line-height:22px;font-weight:500;margin:0 0 8px}.lanw .lanw-account-wizard .lanw-capability-settings{gap:8px}.lanw .lanw-account-wizard .lanw-capability-tabs{padding:3px;gap:2px}.lanw .lanw-account-wizard .lanw-capability-tabs .lanw-btn{min-height:32px;padding:5px 12px;font-size:13px;line-height:20px}.lanw .lanw-account-wizard [data-capability-policy]>.lanw-policy-summary{position:absolute;top:0;right:0;margin:0;line-height:22px}.lanw .lanw-account-wizard .lanw-setting-row{min-height:44px;padding:10px 0}.lanw .lanw-account-wizard .lanw-policy-pane>.lanw-stack{gap:12px}
@media(max-width:620px){.lanw .lanw-account-wizard .lanw-edit-body{padding:16px}}
.lanw .lanw-account-wizard.lanw-permission-step[data-edit-dialog]{width:min(720px,calc(100vw - 48px))}
@media(max-width:620px){.lanw .lanw-account-wizard.lanw-permission-step[data-edit-dialog]{width:calc(100vw - 24px)}}
.lanw .lanw-btn-danger{color:var(--dsw-alias-state-error-primary)}
.lanw .lanw-edit-body [data-password-danger]{margin:0;padding:0;border:0}.lanw #lanw-reset-password-form{width:100%;max-width:480px}.lanw #lanw-reset-password-form>.lanw-fieldset{gap:20px}.lanw #lanw-reset-password-form .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:0;border:0}.lanw #lanw-reset-password-form .lanw-check{align-items:flex-start;line-height:22px}.lanw #lanw-reset-password-form .lanw-check input{margin-top:2px}
.lanw .lanw-branding{max-width:none;gap:16px}.lanw .lanw-branding>p{margin:0}.lanw .lanw-brand-preview{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:16px;padding:14px 16px}.lanw-brand-preview-pane{display:flex;flex-direction:column;gap:8px;min-width:0}.lanw-brand-preview-pane>.lanw-help{font-size:11px;line-height:18px}.lanw .lanw-brand-headline{justify-content:flex-start;flex-wrap:wrap;gap:8px;min-height:32px;font-size:18px;line-height:26px}.lanw .lanw-brand-headline>span{text-align:left}.lanw .lanw-brand-sidebar-preview{min-height:32px}
.lanw .lanw-branding .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:7px;padding:0;border:0;min-width:0}.lanw .lanw-branding .lanw-field>span{font-size:13px;line-height:20px}.lanw .lanw-branding .lanw-field input{width:100%;min-width:0;height:38px}.lanw .lanw-branding input[type=file]{padding:4px;font-size:12px}.lanw .lanw-branding input::file-selector-button{padding:4px 8px;line-height:18px}.lanw .lanw-branding .lanw-fieldset{gap:18px}.lanw .lanw-brand-field-group{display:flex;flex-direction:column;gap:7px;min-width:0}.lanw .lanw-brand-field-group>.lanw-help{font-size:12px;line-height:19px}.lanw .lanw-brand-logo-fields,.lanw .lanw-brand-name-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;min-width:0}
.lanw-brand-actions{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:2px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
@media(max-width:640px){.lanw .lanw-brand-preview,.lanw .lanw-brand-logo-fields,.lanw .lanw-brand-name-fields{grid-template-columns:minmax(0,1fr)}.lanw .lanw-brand-preview{gap:14px}.lanw-brand-actions{position:static}}
.lanw-sidebar-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 12px 18px}.lanw .lanw-sidebar-heading .lanw-window-title{margin:0}.lanw-sidebar-actions{display:flex;align-items:center;gap:2px;flex:none}.lanw .lanw-sidebar-actions>.lanw-btn{width:26px;min-width:26px;height:28px;min-height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}.lanw .lanw-sidebar-actions>.lanw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lanw .lanw-info-dialog{width:min(520px,calc(100vw - 48px));height:fit-content;min-height:0;max-height:calc(100dvh - 48px);padding:0;overflow:hidden}.lanw .lanw-info-dialog[open]{display:flex;flex-direction:column}.lanw-info-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw .lanw-info-dialog .lanw-info-header h2{font-size:16px;line-height:24px;font-weight:500}.lanw .lanw-info-dialog .lanw-info-intro{margin:5px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}.lanw .lanw-info-header>.lanw-btn{flex:none;width:28px;height:28px;min-height:28px;padding:0;border:0;background:transparent}.lanw .lanw-info-content{min-height:0;overflow-y:auto;padding:0 24px 10px;overscroll-behavior:contain}.lanw .lanw-info-content section{display:flex;flex-direction:column;gap:8px;padding:14px 0}.lanw .lanw-info-content section:last-child{padding-bottom:10px}.lanw .lanw-info-content h3{margin:0;font-size:13px;line-height:22px;font-weight:500}.lanw .lanw-info-content p{margin:0;font-size:13px;line-height:20px}.lanw .lanw-info-content .lanw-btn{align-self:flex-start;margin-top:2px}.lanw .lanw-info-content .lanw-entry-link{margin-top:2px;padding:9px 12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}
.lanw-page-main .lann-account{gap:20px}.lanw-page-main .lann-account dl{grid-template-columns:96px minmax(0,1fr);gap:12px 16px;padding-bottom:20px}.lanw-page-main .lann-account dd:first-of-type{font-weight:500}.lanw-page-main .lann-account .lann-entry-link{align-self:stretch;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base))}.lanw-page-main .lann-actions{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-page-main .lann-account button{min-height:32px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 9%,var(--dsw-alias-bg-base));background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}.lanw-page-main .lann-actions button:last-child{color:var(--dsw-alias-state-error-primary)}
@media(max-width:640px){.lanw.lanw--sidebar{grid-template-rows:auto minmax(0,1fr)}.lanw .lanw-secondary-nav{display:block;padding:20px 20px 0;overflow:visible}.lanw-secondary-nav>nav{display:none}.lanw-sidebar-heading{margin:0}.lanw .lanw-info-header{padding:16px 20px}.lanw .lanw-info-content{padding:0 20px 8px}.lanw-page-main .lann-account dl{grid-template-columns:80px minmax(0,1fr)}}
.lanw .lanw-accountlist th:first-child{width:38%}.lanw .lanw-accountlist th:nth-child(3){width:15%}
.lanw #lanw-reset-password-form .lanw-check{padding:0;border:0;background:transparent}.lanw #lanw-account-limits-form .lanw-stack{gap:0}.lanw #lanw-account-limits-form .lanw-field{padding:12px 0}.lanw #lanw-account-limits-form .lanw-help{margin-top:12px}.lanw .lanw-policy-pane>.lanw-stack>.lanw-btn{align-self:flex-start}
.lanw-usage table{font-variant-numeric:tabular-nums}.lanw-usage :is(th,td):not(:first-child){text-align:right;white-space:nowrap}.lanw-usage thead th{border-bottom:1px solid var(--dsw-alias-border-l1)}
.lanw-content-menu-host{display:contents}
.lanw-member-picker{position:relative}.lanw .lanw-member-picker input[role=combobox]{padding-right:26px}.lanw-member-picker:after{content:'';position:absolute;right:12px;top:13px;width:6px;height:6px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg);pointer-events:none;color:var(--dsw-alias-label-secondary)}.lanw-member-options{position:absolute;z-index:30;top:calc(100% + 4px);left:0;right:0;max-height:min(240px,40vh);overflow:auto;overscroll-behavior:contain;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}.lanw .lanw-member-options button[role=option]{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:7px 9px;border:0;border-radius:6px;text-align:left;font:inherit;font-size:13px;line-height:18px;white-space:normal;overflow-wrap:anywhere;background:transparent;color:var(--dsw-alias-label-primary)}.lanw .lanw-member-options button[role=option]:hover,.lanw .lanw-member-options button[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}.lanw-member-options small{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}.lanw-member-options p,.lanw-member-options>div[role=alert]{padding:8px 9px;font-size:12px}
.lanw .lanw-grant-copy>.lanw-row{align-items:flex-start}
.lanw-member-picker{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0}.lanw .lanw-member-picker :is(input,select){width:100%;min-width:0;height:34px;padding:5px 8px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.lanw-member-picker .lanw-pager{justify-content:flex-end;font-size:12px;gap:6px}.lanw .lanw-member-picker .lanw-btn{min-height:26px;height:26px;font-size:12px;padding:2px 6px}
.lanw-grant-copy{display:flex;flex-direction:column;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-grant-copy .lanw-row{flex-wrap:nowrap}.lanw .lanw-grant-copy select{flex:1;min-width:0;max-width:100%;height:34px;padding:5px 8px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.lanw-grant-copy .lanw-help{font-size:12px}.lanw-effective-access{margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-effective-access>.lanw-stack{margin-top:12px}.lanw-effective-access .lanw-btn{align-self:flex-start}.lanw-effective-access table{table-layout:fixed;min-width:450px}.lanw .lanw-effective-access :is(th,td){white-space:normal;overflow-wrap:anywhere;font-size:12px;padding:8px 6px;vertical-align:top}.lanw-effective-access tbody tr+tr>*{border-top:1px solid var(--dsw-alias-border-l1)}@media(max-width:480px){.lanw-grant-copy .lanw-row{flex-wrap:wrap}.lanw-grant-copy select{flex-basis:100%}}
.lanw-invitation-history{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-invitation-history>summary{font-weight:500;line-height:24px}.lanw-invitation-history>.lanw-stack{margin-top:12px}.lanw-invitation-history>.lanw-stack>.lanw-btn{align-self:flex-start}.lanw-invitation-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lanw-invitation-row>div:first-child{min-width:0;overflow-wrap:anywhere}.lanw-invitation-row strong{font-weight:500}.lanw-invitation-row .lanw-help{font-size:12px}@media(max-width:480px){.lanw-invitation-row{align-items:flex-start;flex-direction:column}}
.lanw-password-settings{margin-top:24px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l1)}.lanw-password-settings summary{cursor:pointer;font-weight:500;line-height:24px}.lanw-password-settings>p{margin:10px 0 16px}.lanw-password-settings form{max-width:440px}.lanw .lanw-password-settings .lanw-field{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:0;border:0}.lanw-password-settings button{align-self:flex-start}
.lanw-workspace-window:has([data-service-entry]){width:min(540px,calc(100vw - 48px));height:auto;max-height:calc(100dvh - 48px);overflow-y:auto}.lanw-service-entry{padding:36px;gap:18px}.lanw-service-entry .lanw-page-heading{margin:0 32px 4px 0}.lanw-service-entry .lanw-btn{align-self:flex-start;text-decoration:none}.lanw-service-address{overflow-wrap:anywhere}.lanw-service-maintenance{padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px}.lanw-service-maintenance summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.lanw-service-maintenance[open]{display:flex;flex-direction:column;gap:12px}.lanw-service-maintenance .lanw-btn{font-size:12px}@media(max-width:480px){.lanw-service-entry{padding:28px 24px}}
`;

    function failure(code, message) {
      const error = new Error(message || code);
      error.code = code;
      return error;
    }
    const list = value => Array.isArray(value) ? value : [];
    const OWNER_USERNAME_KEY = 'lan-workspace.owner.username';
    function rememberedUsername() {
      try { const name = window.localStorage?.getItem(OWNER_USERNAME_KEY); return typeof name === 'string' && name.length <= 64 ? name : ''; } catch { return ''; }
    }
    function rememberUsername(name, remember) {
      try {
        if (remember && typeof name === 'string' && name.length <= 64) window.localStorage?.setItem(OWNER_USERNAME_KEY, name);
        else window.localStorage?.removeItem(OWNER_USERNAME_KEY);
      } catch {}
    }
    function sessionAuth(result) {
      if (!result?.csrf || !result?.user?.id || result.cookieSession !== true && !result.token) throw failure('INVALID_RESPONSE');
      return { csrf: result.csrf, ...(result.token ? { token: result.token } : {}) };
    }
    function modelGroups(catalog) {
      const groups = new Map();
      for (const variant of list(catalog)) {
        const key = `${variant.provider}\u0000${variant.model}`;
        if (!groups.has(key)) groups.set(key, { key, providerName: variant.providerName || '—', modelName: variant.modelName || variant.label || '—', variants: [] });
        groups.get(key).variants.push(variant);
      }
      const order = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      return [...groups.values()].sort((a, b) => a.providerName.localeCompare(b.providerName, 'en', { numeric: true }) || a.modelName.localeCompare(b.modelName, 'en', { numeric: true }) || a.key.localeCompare(b.key, 'en', { numeric: true })).map(group => ({ ...group, variants: group.variants.map((value, index) => ({ value, index })).sort((a, b) => {
        const rank = item => { const found = order.indexOf(item.reasoningEffort); return found < 0 ? order.length : found; };
        return rank(a.value) - rank(b.value) || a.index - b.index;
      }).map(item => item.value) }));
    }
    function memberEntryUrl(value, ownerHref = window.location.href) {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value), owner = new URL(ownerHref);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/lan/' || (!window.__DSH_LAN_MEMBER__ && url.hostname.toLowerCase() === owner.hostname.toLowerCase())) return null;
        return url.href;
      } catch { return null; }
    }

    // Reuse the last authenticated member view across native settings mounts.
    // This cache is page-local; a 401/logout clears it and never restores login.
    let memberSnapshot = null;
    let branding = Object.freeze({ revision: 0, logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true });
    const brandingListeners = new Set();
    function publishBranding(value) {
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.logo !== null && typeof value.logo !== 'string' || value.slogan !== null && typeof value.slogan !== 'string') return;
      if (value.name != null && typeof value.name !== 'string' || value.badge != null && typeof value.badge !== 'string') return;
      if (value.showPreviewBadge !== undefined && typeof value.showPreviewBadge !== 'boolean') return;
      const next = { revision: value.revision, logo: value.logo, slogan: value.slogan, name: value.name ?? null, badge: value.badge ?? null, showPreviewBadge: value.showPreviewBadge ?? true };
      if (next.revision < branding.revision || JSON.stringify(next) === JSON.stringify(branding)) return;
      branding = Object.freeze(next);
      for (const listener of [...brandingListeners]) listener();
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = Object.entries(messages).map(([locale, dictionary]) => ctx.locale.register(NS, locale, dictionary));
          return () => disposers.reverse().forEach(dispose => dispose());
        });
        const nativeText = ctx.locale.bind('conversation');
        const brandingController = new AbortController();
        let brandingLoad;
        const loadBranding = () => brandingLoad ??= send({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }), signal: brandingController.signal })
          .then(async response => { const answer = await response.json(); if (!brandingController.signal.aborted && response.ok && answer?.ok) publishBranding(answer.result?.branding); }).catch(() => {});
        ctx.effect(() => () => brandingController.abort());
        function useBranding() {
          return React.useSyncExternalStore(listener => { brandingListeners.add(listener); return () => brandingListeners.delete(listener); }, () => branding, () => branding);
        }
        function BrandLogo({ logo, size = 34, className, onError, maxWidth = 120 }) {
          const [failed, setFailed] = React.useState(false);
          React.useEffect(() => { setFailed(false); }, [logo]);
          return logo && !failed
            ? h('img', { className: className || 'lanw-brand-logo', src: logo, alt: 'Logo', referrerPolicy: 'no-referrer', style: { display: 'block', flex: 'none', width: maxWidth === size ? size : 'auto', height: size, maxWidth, maxHeight: size, objectFit: 'contain' }, onError: () => { setFailed(true); onError?.(); } })
            : h('svg', { className, width: size, height: size * FISH_LOGO_VIEWBOX.height / FISH_LOGO_VIEWBOX.width, viewBox: `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`, fill: 'currentColor', 'aria-hidden': true }, h('path', { d: FISH_LOGO_PATH }));
        }
        function HeroBrand({ size, className }) {
          const value = useBranding();
          return h('span', { 'data-lanw-brand-mark': true, 'data-custom-slogan': Boolean(value.slogan), 'data-show-preview-badge': value.showPreviewBadge, style: { display: 'inline-flex', alignItems: 'center', gap: 10, maxWidth: 'min(560px, 75vw)', overflowWrap: 'anywhere' } },
            h('style', null, 'span:has([data-lanw-brand-mark][data-custom-slogan=true])+span>span:first-child{display:none}span:has([data-lanw-brand-mark][data-show-preview-badge=false])+span>span:nth-child(2){display:none}[data-lanw-brand-mark] img{display:block;flex:none}[data-lanw-brand-slogan]{min-width:0;white-space:normal;text-align:center}'),
            h(BrandLogo, { logo: value.logo, size, className }), value.slogan && h('span', { 'data-lanw-brand-slogan': true }, value.slogan));
        }
        ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', () => {
          let dispose;
          const reconcile = () => {
            if ((branding.logo || branding.slogan || !branding.showPreviewBadge) && !dispose) dispose = ctx.slots.register({ name: 'conversation.hero.brand.mark', id: 'lan-workspace-branding', priority: -100 }, HeroBrand);
            else if (!branding.logo && !branding.slogan && branding.showPreviewBadge) { dispose?.(); dispose = undefined; }
          };
          brandingListeners.add(reconcile); reconcile();
          void loadBranding();
          return () => { brandingListeners.delete(reconcile); dispose?.(); };
        }));
        function SidebarBrand({ size = 24 }) {
          const value = useBranding();
          return h('span', { 'data-lanw-sidebar-logo': true, style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: size, height: size } },
            h(BrandLogo, { logo: value.logo, size, maxWidth: size }));
        }
        function BrandName({ name, badge }) {
          const tag = badge ?? 'HARNESS';
          return h('span', { 'data-lanw-sidebar-name': true, style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h('span', { 'data-lanw-brand-name': true, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 18, fontWeight: 600 } }, name || 'deepseek'),
            tag && h('span', { 'data-lanw-brand-badge': true, style: { flex: 'none', borderRadius: 3, padding: '1px 4px', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)', fontSize: 10, fontWeight: 600, lineHeight: '14px', letterSpacing: '.04em', whiteSpace: 'nowrap' } }, tag));
        }
        function SidebarBrandName() { const value = useBranding(); return h(BrandName, { name: value.name, badge: value.badge }); }
        ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', () => {
          let mark, name;
          const reconcile = () => {
            if (branding.logo && !mark) mark = ctx.slots.register({ name: 'sidebar.brand.mark', id: 'lan-workspace-sidebar-logo', priority: -100 }, SidebarBrand);
            else if (!branding.logo) { mark?.(); mark = undefined; }
            if ((branding.name !== null || branding.badge !== null) && !name) name = ctx.slots.register({ name: 'sidebar.brand.name', id: 'lan-workspace-sidebar-name', priority: -100 }, SidebarBrandName);
            else if (branding.name === null && branding.badge === null) { name?.(); name = undefined; }
          };
          brandingListeners.add(reconcile); reconcile(); void loadBranding();
          return () => { brandingListeners.delete(reconcile); mark?.(); name?.(); };
        })));
        const t = ctx.locale.bind(NS);
        function useLocale() {
          React.useSyncExternalStore(
            React.useCallback(notify => ctx.locale.subscribe(notify), []),
            React.useCallback(() => ctx.locale.getSnapshot(), []),
            React.useCallback(() => ctx.locale.getSnapshot(), []),
          );
        }
        function Button({ children, primary, className = '', ...props }) {
          return h('button', { type: 'button', ...props, className: `lanw-btn ${primary ? 'lanw-btn-primary' : ''} ${className}` }, children);
        }
        const navigationIcons = {
          account: IconUserOutlineRegular, preferences: IconSlidersTwoOutlineRegular, accounts: IconUsersOutlineRegular,
          content: IconFolderOpenOutlineRegular, models: IconDatabaseOutlineRegular, sharing: IconShareOutlineRegular,
          branding: IconPersonalizationOutlineRegular, usage: IconGaugeOutlineRegular, capabilities: IconSparkleRegular,
          limits: IconGaugeOutlineRegular, directories: IconFolderOpenOutlineRegular, status: IconCheckCircleOutlineRegular,
          security: IconShieldOutlineRegular, features: IconSlidersTwoOutlineRegular, skills: IconSkillOutlineRegular,
          mcpServers: IconApiOutlineRegular, cliTools: IconApiOutlineRegular, agentPresets: IconAgentPresetOutlineRegular, plugins: IconPluginPinwheelOutlineRegular,
          permissionPresets: IconShieldOutlineRegular, sessions: IconNewChatOutlineRegular, files: IconFolderOpenOutlineRegular,
        };
        function NavigationLabel({ id, children }) {
          const Icon = navigationIcons[id];
          return h('span', { className: 'lanw-nav-label' }, Icon && h(Icon, { size: 16, 'aria-hidden': true, focusable: false }), h('span', null, children));
        }
        function isDismissKey(event) {
          return event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229;
        }
        function containDialogEscape(event) {
          if (!isDismissKey(event)) return;
          event.stopPropagation();
          if (event.repeat) event.preventDefault();
        }
        function Field({ label, description, children, ...props }) {
          return h('label', { className: 'lanw-field' }, h('span', null, label, description && h('small', { className: 'lanw-field-description' }, description)), children || h('input', props));
        }
        function Check({ label, ...props }) {
          return h('label', { className: 'lanw-check' }, h('input', { type: 'checkbox', ...props }), h('span', null, label));
        }
        function FeatureToggle({ label, description, name, checked, disabled = false, onChange }) {
          return h('div', { className: 'lanw-setting-row' }, h('div', null, h('span', null, label), description && h('p', { className: 'lanw-help' }, description)),
            name && h('input', { type: 'checkbox', name, checked, disabled, onChange, hidden: true, 'aria-hidden': true, tabIndex: -1 }),
            h(Switch, { label, checked, disabled, onChange: next => onChange({ target: { checked: next } }) }));
        }
        Object.assign(messages.zh, { accessCliTools: 'CLI 工具', cliAccess: 'CLI 使用权限', inheritCli: '使用已开放的 CLI', customCli: '仅允许所选 CLI', cliNote: '成员可在终端和命令中直接运行所选 CLI。命令与凭据由管理员配置。', cliEmpty: '尚未配置 CLI。管理员可在插件设置中的“成员 CLI 工具”添加命令。' });
        Object.assign(messages.en, { accessCliTools: 'CLI tools', cliAccess: 'CLI access', inheritCli: 'Use available CLIs', customCli: 'Only selected CLIs', cliNote: 'Members can run selected CLIs in commands and terminals. Administrators configure commands and credentials.', cliEmpty: 'No CLIs configured. Add commands in the Member CLI Tools plugin settings.' });
        Object.assign(messages.zh, {
          cliToolsDescription: '配置服务器上的命令，再通过账号授权分配给成员。',
          cliSetupNote: '先在服务器安装程序，再添加命令。这里管理命令入口，不安装或删除程序文件。',
          cliSaveNote: '保存变更会关闭成员当前的执行资源；重新打开会话后使用新配置。',
          cliAdd: '指定工具', cliCommandName: '命令名称', cliDisplayName: '显示名称', cliProgram: '可执行程序',
          cliTarget: '工具名称或可执行路径', cliInspect: '识别工具', cliConfigureManually: '手动填写', cliTargetNote: '例如 rg、python3 或绝对路径。只读取指定程序的元数据，不运行程序；参数在下方填写。', cliInspected: '已识别指定工具，配置已预填。请确认运行依赖与开放范围，保存后生效。',
          cliProgramNote: '服务器上的绝对路径，例如 /usr/bin/python3。', cliArguments: '固定参数', cliArgument: '参数', cliAddArgument: '添加参数',
          cliPaths: '只读依赖路径', cliPathsNote: '每行一个绝对路径，只开放程序运行所需的文件或目录。',
          cliAdvanced: '环境变量与凭据', cliEnvironment: '环境变量', cliCredentials: '凭据引用',
          cliCredentialNote: '填写 DSH 凭据服务中的引用名称，不在此填写密钥。授权成员运行 CLI 时可读取所提供的凭据。',
          cliVariable: '变量名称', cliValue: '变量值', cliReference: '凭据引用名称', cliAddVariable: '添加变量', cliAddCredential: '添加引用',
          cliRemove: '移除', cliRemoveConfirm: '移除此命令入口？程序文件会保留。', cliConfirmRemove: '确认移除',
          cliSaved: '配置已保存。可到「成员管理 → 账号授权 → 能力权限 → CLI 工具」分配使用权限。',
          cliNoTools: '还没有 CLI 工具，添加服务器上已安装的命令即可开始。', cliEnabled: '开放此命令', cliDisabled: '已停用',
          cliDuplicateVariable: '变量名称不能为空或重复。', toolNames: '工具权限',
          cliEmpty: '尚未配置 CLI。管理员可在「多用户服务 → 共享环境 → 执行工具」添加命令。',
        });
        Object.assign(messages.en, {
          cliToolsDescription: 'Register server commands, then grant members access.',
          cliSetupNote: 'Install the program on the server first. This page manages command registrations, not program files.',
          cliSaveNote: 'Saving changes closes members’ current execution resources. Reopen sessions to use the new configuration.',
          cliAdd: 'Specify tool', cliCommandName: 'Command name', cliDisplayName: 'Display name', cliProgram: 'Executable path',
          cliTarget: 'Tool name or executable path', cliInspect: 'Identify tool', cliConfigureManually: 'Enter manually', cliTargetNote: 'For example rg, python3 or an absolute path. Only the selected program metadata is read; the program is not run. Add arguments below.', cliInspected: 'The selected tool was identified and the configuration prefilled. Review its dependencies and access before saving.',
          cliProgramNote: 'An absolute server path, such as /usr/bin/python3.', cliArguments: 'Fixed arguments', cliArgument: 'Argument', cliAddArgument: 'Add argument',
          cliPaths: 'Read-only dependencies', cliPathsNote: 'One absolute path per line. Include only files or directories needed by this program.',
          cliAdvanced: 'Environment and credentials', cliEnvironment: 'Environment variables', cliCredentials: 'Credential references',
          cliCredentialNote: 'Use reference names from the DSH credential service, not secret values. Authorized members can read credentials supplied to their CLI.',
          cliVariable: 'Variable name', cliValue: 'Value', cliReference: 'Credential reference', cliAddVariable: 'Add variable', cliAddCredential: 'Add reference',
          cliRemove: 'Remove', cliRemoveConfirm: 'Remove this command registration? Program files will be kept.', cliConfirmRemove: 'Confirm removal',
          cliSaved: 'Configuration saved. Grant access in Member accounts → Account access → Capabilities → CLI tools.',
          cliNoTools: 'No CLI tools yet. Add a command already installed on the server.', cliEnabled: 'Make this command available', cliDisabled: 'Disabled',
          cliDuplicateVariable: 'Variable names must be nonempty and unique.', toolNames: 'Tool permissions',
          cliEmpty: 'No CLIs configured. Administrators can add commands in Multi-user service → Shared environment → Execution tools.',
        });
        Object.assign(messages.zh, {
          executionToolCatalog: '执行工具', cliToolsDescription: '管理指定工具，以及已登记来源中的 tool-runner 工具。',
          executionIntro: 'Skill 由用户自己管理。这里按工具及操作授权，不需要等待执行失败，也不修改 Skill。',
          executionScan: '扫描工具', executionSave: '保存白名单', executionExport: '导出配置', executionImport: '导入配置文件', executionImportSave: '保存导入配置',
          executionSources: '扫描来源', executionSourceId: '来源名称', executionSourceRoot: 'tool-runner 安装目录', executionSourceCommand: 'tool-runner 可执行程序', executionSourceAdd: '添加来源',
          executionHarness: '供 Harness 使用', executionShared: '共享给成员', executionSharedNote: '共享后仍需通过成员账号的执行工具权限控制。',
          executionUsage: '操作与用法', executionViewUsage: '用法', executionOperation: '操作', executionParameters: '参数', executionRequired: '必填',
          executionStale: '工具已更新，请重新勾选确认授权。', executionMissing: '未扫描到的授权项', executionMissingNote: '请检查扫描来源，或移除失效授权。',
          executionSaved: '工具白名单已保存。', executionEmpty: '点击扫描查看已安装工具；没有可用来源时，可添加 tool-runner 安装目录。',
          executionSourceEmpty: '未发现 tool-runner 安装，请添加扫描来源。', executionSearch: '搜索工具、用途或操作',
          executionConfigError: '请选择有效的 dsh-execution-tools JSON 配置文件（最大 128 KiB）。', executionImportReady: '配置已读取，保存后生效。',
          executionManual: '指定工具与导入配置', executionManualNote: '指定一个命令名称或可执行路径来预填配置，也可手动填写或导入通用配置文件。',
          executionRetireNote: '保存变更会关闭成员当前执行资源，重新打开会话后生效。', executionUnused: '尚未授权', executionUnavailable: '源工具已停用',
          executionSkill: '关联 Skill', executionNoSkillCopy: '仅查看关联，不会复制或改写用户 Skill。',
          executionNeedsReview: '待确认',
          executionManage: '管理',
          executionSaveSources: '保存并扫描', executionSourceChangeNote: '修改或移除来源后，需要重新确认该来源下的工具授权。',
          executionSourceSearch: '搜索来源名称或路径', executionSourceDuplicate: '来源名称已存在，请使用其他名称。',
          executionSourceApplyAdd: '检测并添加到列表', executionSourceApplyEdit: '检测并应用修改', executionSourceToolCount: '个工具',
          executionSourceStaged: '来源已更新到列表，保存并扫描后生效。',
        });
        Object.assign(messages.en, {
          executionToolCatalog: 'Execution tools', cliToolsDescription: 'Manage specified commands and tools from registered tool-runner sources.',
          executionIntro: 'Skills remain user-managed. Grant tools and operations here before use, without changing Skills.',
          executionScan: 'Scan tools', executionSave: 'Save whitelist', executionExport: 'Export configuration', executionImport: 'Import configuration', executionImportSave: 'Save imported configuration',
          executionSources: 'Discovery sources', executionSourceId: 'Source name', executionSourceRoot: 'tool-runner installation directory', executionSourceCommand: 'tool-runner executable', executionSourceAdd: 'Add source',
          executionHarness: 'Available to Harness', executionShared: 'Share with members', executionSharedNote: 'Shared tools remain subject to individual member execution-tool permissions.',
          executionUsage: 'Operations and usage', executionViewUsage: 'Usage', executionOperation: 'Operation', executionParameters: 'Parameters', executionRequired: 'required',
          executionStale: 'The tool changed. Select access again to approve the current version.', executionMissing: 'Grants not found in this scan', executionMissingNote: 'Check discovery sources or remove obsolete grants.',
          executionSaved: 'Tool whitelist saved.', executionEmpty: 'Scan to inspect installed tools. Add a tool-runner installation if none is available.',
          executionSourceEmpty: 'No tool-runner installation found. Add a discovery source.', executionSearch: 'Search tools, descriptions or operations',
          executionConfigError: 'Choose a valid dsh-execution-tools JSON configuration, no larger than 128 KiB.', executionImportReady: 'Configuration loaded. Save to apply it.',
          executionManual: 'Specified tools and configuration import', executionManualNote: 'Specify one command name or executable path to prefill its configuration, enter it manually, or import a shared configuration file.',
          executionRetireNote: 'Saving changes closes members’ current execution resources. Reopen sessions to apply the configuration.', executionUnused: 'Not authorized', executionUnavailable: 'Disabled at source',
          executionSkill: 'Associated Skill', executionNoSkillCopy: 'The association is informational. User Skills are not copied or modified.',
          executionNeedsReview: 'Needs review',
          executionManage: 'Manage',
          executionSaveSources: 'Save and scan', executionSourceChangeNote: 'Changing or removing a source requires its tool permissions to be confirmed again.',
          executionSourceSearch: 'Search source names or paths', executionSourceDuplicate: 'This source name already exists. Choose another name.',
          executionSourceApplyAdd: 'Check and add to list', executionSourceApplyEdit: 'Check and apply changes', executionSourceToolCount: 'tools',
          executionSourceStaged: 'Source updated in the list. Save and scan to apply it.',
        });
        function downloadExecutionConfiguration(value) {
          const blob = new Blob([JSON.stringify({ format: 'dsh-execution-tools', version: 1, tools: value.tools, executionTools: value.executionTools })], { type: 'application/json' });
          const url = URL.createObjectURL(blob), link = document.createElement('a');
          link.href = url; link.download = 'dsh-execution-tools.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        function ExecutionToolsManager({ request, onSaved, disabled }) {
          const [saved, setSaved] = React.useState(null), [draft, setDraft] = React.useState(null), [inventory, setInventory] = React.useState(null);
          const [page, setPage] = React.useState(0), [size, setSize] = React.useState(5);
          const [managedTool, setManagedTool] = React.useState(null), manageOpener = React.useRef(null);
          const [manageSources, setManageSources] = React.useState(false), sourcesOpener = React.useRef(null);
          const [busy, setBusy] = React.useState(false), [problem, setProblem] = React.useState(''), [notice, setNotice] = React.useState(''), [search, setSearch] = React.useState('');
          const blocked = disabled || busy;
          const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(saved.executionTools);
          async function scan(value) {
            return request('admin.cliTools', { operation: 'scan', sources: value.sources });
          }
          async function load() {
            setBusy(true); setProblem(''); setNotice('');
            try {
              const value = await request('admin.cliTools', { operation: 'read' });
              const next = { ...value.executionTools, sources: value.executionTools.sources.length ? value.executionTools.sources : value.suggestedSources };
              setSaved(value); setDraft(next); setInventory(await scan(next)); setPage(0);
            } catch (error) { setProblem(error.message); }
            finally { setBusy(false); }
          }
          React.useEffect(() => { load(); }, []);
          const change = next => { setDraft(next); setProblem(''); setNotice(''); };
          function openManager(tool, opener) {
            const existing = draft.grants.find(row => row.id === tool.id);
            const current = existing?.fingerprint === tool.fingerprint;
            const grant = { id: tool.id, fingerprint: tool.fingerprint, operations: current ? [...existing.operations] : tool.operations.filter(row => row.enabled).map(row => row.id), harness: current && existing.harness, shared: current && existing.shared };
            manageOpener.current = opener; setProblem(''); setManagedTool({ tool, grant, stale: !!existing && !current });
          }
          async function refreshScan() {
            setBusy(true); setProblem(''); setNotice('');
            try { setInventory(await scan(draft)); setPage(0); } catch (error) { setProblem(error.message); } finally { setBusy(false); }
          }
          async function save(configuration) {
            setBusy(true); setProblem(''); setNotice('');
            try {
              const value = await request('admin.cliTools', { operation: 'save', expectedRevision: saved.revision, executionTools: configuration });
              setSaved(value); setDraft(value.executionTools); setNotice(t('executionSaved'));
              try { setInventory(await scan(value.executionTools)); await onSaved(); } catch (error) { setProblem(error.message); }
              return true;
            } catch (error) { setProblem(error.message); return false; } finally { setBusy(false); }
          }
          async function saveSources(configuration) {
            setBusy(true); setProblem('');
            try {
              const inventory = await scan(configuration), failed = inventory.errors.find(row => !row.tool);
              if (failed) { setProblem(`${failed.sourceId}: ${failed.message}`); return; }
              if (await save(configuration)) setManageSources(false);
            } catch (error) { setProblem(error.message); } finally { setBusy(false); }
          }
          const tools = (inventory?.tools ?? []).filter(tool => `${tool.id} ${tool.description} ${tool.skill} ${tool.operations.map(row => `${row.id} ${row.description}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
          const missing = (draft?.grants ?? []).filter(row => !inventory?.tools.some(tool => tool.id === row.id) && row.id.toLowerCase().includes(search.toLowerCase()));
          const rows = [...tools, ...missing.map(row => ({ id: row.id, missing: row }))];
          const pages = Math.max(1, Math.ceil(rows.length / size)), current = Math.min(page, pages - 1);
          React.useEffect(() => { setPage(previous => Math.min(previous, pages - 1)); }, [pages]);
          return h('div', { className: 'lanw-stack lanw-execution-catalog', 'data-execution-catalog': true, 'aria-busy': busy },
            problem && h('p', { className: 'lanw-error', role: 'alert' }, problem), notice && h('p', { className: 'lanw-help', role: 'status' }, notice),
            !draft ? h('p', { className: 'lanw-help' }, t('loading')) : h(React.Fragment, null,
              h('div', { className: 'lanw-execution-toolbar' },
                h('input', { type: 'search', 'aria-label': t('executionSearch'), placeholder: t('executionSearch'), value: search, onChange: event => { setSearch(event.target.value); setPage(0); } }),
                h(Button, { primary: !dirty, disabled: blocked, onClick: refreshScan }, t('executionScan')),
                h(Button, { disabled: blocked, 'aria-haspopup': 'dialog', 'data-manage-execution-sources': true, onClick: event => { sourcesOpener.current = event.currentTarget; setProblem(''); setManageSources(true); } }, t('executionSources')),
                dirty && h(Button, { primary: true, disabled: blocked, onClick: () => save(draft) }, t('executionSave')),
                h(ExecutionMore, { disabled: blocked, onExport: () => downloadExecutionConfiguration({ ...saved, executionTools: draft }), onReload: load })),
              (inventory?.errors ?? []).map((error, index) => h('p', { className: 'lanw-error', role: 'status', key: index }, `${error.sourceId}${error.tool ? '/' + error.tool : ''}: ${error.message}`)),
              !rows.length && h('p', { className: 'lanw-empty' }, t(search ? 'noMatches' : 'executionEmpty')),
              h('div', { className: 'lanw-execution-tool-list' }, rows.slice(current * size, (current + 1) * size).map(tool => {
                if (tool.missing) return h('div', { className: 'lanw-cli-card', key: tool.id, 'data-execution-tool': tool.id }, h('p', null, `${t('executionMissing')}: ${tool.id}`), h('p', { className: 'lanw-help' }, t('executionMissingNote')),
                  h(Button, { disabled: blocked, onClick: () => change({ ...draft, grants: draft.grants.filter(grant => grant.id !== tool.id) }) }, t('cliRemove')));
                const row = draft.grants.find(row => row.id === tool.id), current = row?.fingerprint === tool.fingerprint;
                return h('div', { className: 'lanw-execution-tool', key: tool.id, 'data-execution-tool': tool.id },
                  h('span', { className: 'lanw-execution-tool-name' }, tool.label),
                  h('span', { className: 'lanw-execution-tool-state' },
                    !tool.enabled ? t('executionUnavailable') : row && !current ? t('executionNeedsReview') : current && (row.harness || row.shared)
                      ? [row.harness && h('span', { key: 'harness' }, t('executionHarness')), row.shared && h('span', { key: 'shared' }, t('executionShared'))]
                      : t('executionUnused')),
                  h(Button, { disabled: blocked, 'aria-label': `${t('executionManage')} ${tool.label}`, 'aria-haspopup': 'dialog', 'data-manage-execution-tool': tool.id, onClick: event => openManager(tool, event.currentTarget) }, t('executionManage')));
              })),
              h(ToolPagination, { kind: 'scanned', total: rows.length, page: current, pages, size, disabled: blocked, setPage, setSize: value => { setSize(value); setPage(0); } }),
              managedTool && h(ExecutionToolDialog, { key: managedTool.tool.id, ...managedTool, pending: blocked, problem, returnFocusTo: manageOpener.current, onDraftChange: () => setProblem(''),
                onClose: () => { setManagedTool(null); setProblem(''); },
                onSave: async grant => { if (await save({ ...draft, grants: [...draft.grants.filter(row => row.id !== grant.id), grant] })) setManagedTool(null); },
              }),
              manageSources && h(ExecutionSourceDialog, { configuration: draft, inventory, inspectSource: source => scan({ sources: [source] }), saveAvailable: dirty, pending: blocked, problem, returnFocusTo: sourcesOpener.current, onDraftChange: () => setProblem(''),
                onClose: () => { setManageSources(false); setProblem(''); }, onSave: saveSources,
              })));
        }
        function ExecutionSourceDialog({ configuration, inventory, inspectSource, saveAvailable, pending, problem, returnFocusTo, onClose, onSave, onDraftChange }) {
          const [draft, setDraft] = React.useState(() => ({ ...configuration, sources: configuration.sources.map(source => ({ ...source })), grants: [...configuration.grants] }));
          const [query, setQuery] = React.useState(''), [editor, setEditor] = React.useState(null), [revision, setRevision] = React.useState(0), [notice, setNotice] = React.useState('');
          const [counts, setCounts] = React.useState(() => Object.fromEntries(configuration.sources.map(source => [source.id, (inventory?.tools ?? []).filter(tool => tool.sourceId === source.id).length])));
          const editorOpener = React.useRef(null), dirty = JSON.stringify(draft) !== JSON.stringify(configuration);
          function openEditor(index, opener) {
            let source = draft.sources[index];
            if (!source) {
              let next = 1; while (draft.sources.some(source => source.id === `runner-${next}`)) next++;
              source = { id: `runner-${next}`, kind: 'tool-runner', root: '', command: '' };
            }
            editorOpener.current = opener; setEditor({ index, source }); onDraftChange();
          }
          function applySource(source, count) {
            const sources = [...draft.sources];
            if (editor.index < 0) sources.push(source); else sources[editor.index] = source;
            setDraft(previous => ({ ...previous, sources })); setCounts(previous => ({ ...previous, [source.id]: count }));
            setRevision(previous => previous + 1); setNotice(t('executionSourceStaged')); setQuery(previous => previous.trim() ? source.id : ''); setEditor(null); onDraftChange();
          }
          function removeSource(index) {
            setDraft(previous => ({ ...previous, sources: previous.sources.filter((_, i) => i !== index) }));
            setRevision(previous => previous + 1); setNotice(''); onDraftChange();
          }
          function submit() {
            if (pending) return;
            const changed = configuration.sources.filter(source => !draft.sources.some(row => row.id === source.id && row.kind === source.kind && row.root === source.root && row.command === source.command));
            onSave({ ...draft, grants: draft.grants.filter(row => !changed.some(source => row.id.startsWith(source.id + '/'))) });
          }
          const sources = draft.sources.map((source, index) => ({ source, index })).filter(({ source }) => `${source.id} ${source.root} ${source.command}`.toLowerCase().includes(query.toLowerCase()));
          return h(EditDialog, { title: t('executionSources'), className: 'lanw-execution-sources-dialog', editorKind: 'execution-sources', pending, onClose, returnFocusTo, draftRevision: revision,
            footer: h(Button, { primary: true, disabled: pending || !dirty && !saveAvailable, onClick: submit }, t('executionSaveSources')) },
            h('div', { className: 'lanw-stack', 'data-execution-sources-dialog': true },
              problem && h('p', { className: 'lanw-error', role: 'alert' }, problem),
              h('p', { className: 'lanw-help' }, t('executionSourceChangeNote')), notice && h('p', { className: 'lanw-help', role: 'status' }, notice),
              h('div', { className: 'lanw-row' }, h('span', { className: 'lanw-help lanw-cli-summary' }, `${draft.sources.length} / 16`),
                h(Button, { disabled: pending || draft.sources.length >= 16, 'aria-haspopup': 'dialog', 'data-add-execution-source': true, onClick: event => openEditor(-1, event.currentTarget) }, t('executionSourceAdd'))),
              h('input', { type: 'search', 'data-edit-filter': true, 'aria-label': t('executionSourceSearch'), placeholder: t('executionSourceSearch'), value: query, disabled: pending, onChange: event => setQuery(event.target.value) }),
              !draft.sources.length && h('p', { className: 'lanw-empty' }, t('executionSourceEmpty')),
              draft.sources.length > 0 && !sources.length && h('p', { className: 'lanw-empty' }, t('noMatches')),
              h('div', { className: 'lanw-execution-source-list' }, sources.map(({ source, index }) => h('div', { className: 'lanw-execution-source-row', key: index, 'data-execution-source': source.id },
                h('div', { className: 'lanw-execution-source-summary' }, h('strong', null, source.id), h('span', { className: 'lanw-help' }, source.root)),
                h('div', { className: 'lanw-execution-source-actions' },
                  h('span', { className: 'lanw-help lanw-execution-source-count' }, `${counts[source.id] ?? 0} ${t('executionSourceToolCount')}`),
                  h(Button, { disabled: pending, 'aria-haspopup': 'dialog', 'aria-label': `${t('executionManage')} ${source.id}`, onClick: event => openEditor(index, event.currentTarget) }, t('executionManage')),
                  h(Button, { disabled: pending, 'aria-label': `${t('cliRemove')} ${source.id}`, onClick: () => removeSource(index) }, t('cliRemove')))))),
              h('p', { className: 'lanw-help' }, t('executionRetireNote')),
              editor && h(ExecutionSourceEditor, { key: editor.index, source: editor.source, creating: editor.index < 0, sources: draft.sources, index: editor.index,
                pending, inspectSource, returnFocusTo: editorOpener.current, onClose: () => setEditor(null), onApply: applySource })));
        }
        function ExecutionSourceEditor({ source, creating, sources, index, pending, inspectSource, returnFocusTo, onClose, onApply }) {
          const [draft, setDraft] = React.useState(() => ({ ...source })), [busy, setBusy] = React.useState(false), [problem, setProblem] = React.useState('');
          const blocked = pending || busy, dirty = JSON.stringify(draft) !== JSON.stringify(source);
          const change = fields => { setDraft(previous => ({ ...previous, ...fields })); setProblem(''); };
          async function submit(event) {
            event.preventDefault(); if (blocked) return;
            if (sources.some((row, i) => i !== index && row.id === draft.id)) { setProblem(t('executionSourceDuplicate')); return; }
            setBusy(true); setProblem('');
            try {
              const inventory = await inspectSource(draft), failed = inventory.errors.find(row => !row.tool);
              if (failed) { setProblem(`${failed.sourceId}: ${failed.message}`); return; }
              onApply(draft, inventory.tools.length);
            } catch (error) { setProblem(error.message); } finally { setBusy(false); }
          }
          return h(EditDialog, { title: creating ? t('executionSourceAdd') : `${t('executionManage')} · ${source.id}`, className: 'lanw-execution-source-editor', editorKind: 'execution-source',
            pending: blocked, onClose, returnFocusTo, footer: h(Button, { primary: true, type: 'submit', form: 'lanw-execution-source-form', disabled: blocked || !creating && !dirty }, t(creating ? 'executionSourceApplyAdd' : 'executionSourceApplyEdit')) },
            h('form', { id: 'lanw-execution-source-form', className: 'lanw-stack', 'data-execution-source-editor': true, onSubmit: submit },
              problem && h('p', { className: 'lanw-error', role: 'alert' }, problem),
              h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: blocked },
                h(Field, { label: t('executionSourceId'), value: draft.id, required: true, maxLength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}', onChange: event => change({ id: event.target.value }) }),
                h(Field, { label: t('executionSourceRoot'), value: draft.root, required: true, onChange: event => change({ root: event.target.value }) }),
                h(Field, { label: t('executionSourceCommand'), value: draft.command, required: true, onChange: event => change({ command: event.target.value }) }))));
        }
        function ExecutionToolDialog({ tool, grant, stale, pending, problem, returnFocusTo, onClose, onSave, onDraftChange }) {
          const [draft, setDraft] = React.useState(grant);
          const [expandedOperation, setExpandedOperation] = React.useState(null);
          const dirty = JSON.stringify(draft) !== JSON.stringify(grant);
          const change = fields => { setDraft(previous => ({ ...previous, ...fields })); onDraftChange(); };
          const operations = tool.operations.map(operation => {
            const expanded = expandedOperation === operation.id, detailsId = `lanw-operation-${encodeURIComponent(tool.id + '/' + operation.id)}`;
            const parameters = Object.entries(operation.parameters).map(([key, parameter]) => h(React.Fragment, { key },
              h('dt', null, key), h('dd', null, `${parameter.type}${parameter.required ? ' · ' + t('executionRequired') : ''}${parameter.description ? ' · ' + parameter.description : ''}${parameter.values ? ' · ' + parameter.values.join(', ') : ''}`)));
            return h('div', { className: 'lanw-execution-operation', key: operation.id },
              h('div', { className: 'lanw-execution-operation-row' },
                h(Check, { label: operation.id, checked: draft.operations.includes(operation.id), disabled: pending || !tool.enabled || !operation.enabled,
                  onChange: event => change({ operations: event.target.checked ? [...draft.operations, operation.id] : draft.operations.filter(id => id !== operation.id) }) }),
                h(Button, { 'aria-expanded': expanded, 'aria-controls': detailsId, 'aria-label': `${operation.id} · ${t('executionViewUsage')}`, onClick: () => setExpandedOperation(expanded ? null : operation.id) }, t('executionViewUsage'))),
              expanded && h('div', { id: detailsId, className: 'lanw-execution-operation-details lanw-stack' },
                h('p', { className: 'lanw-help' }, operation.description), parameters.length > 0 && h('dl', { className: 'lanw-execution-parameters' }, parameters)));
          });
          const usage = h('details', { className: 'lanw-execution-usage' }, h('summary', null, `${t('executionUsage')} · ${tool.operations.length}`),
            h('div', { className: 'lanw-stack' }, h('code', { className: 'lanw-cli-path' }, tool.usage),
              h('details', { className: 'lanw-execution-runtime' }, h('summary', null, `${t('cliPaths')} · ${tool.readOnlyPaths?.length ?? 0}`),
                h('div', { className: 'lanw-stack' }, ...(tool.readOnlyPaths ?? []).map(path => h('code', { className: 'lanw-cli-path', key: path }, path)))),
              tool.skill && h('p', { className: 'lanw-help' }, `${t('executionSkill')}: ${tool.skill} · ${t('executionNoSkillCopy')}`), h('div', { className: 'lanw-execution-operations' }, operations)));
          return h(EditDialog, { title: `${t('executionManage')} · ${tool.label}`, subtitle: `${t('executionSources')}: ${tool.sourceId}`, className: 'lanw-execution-dialog', editorKind: 'execution-tool',
            pending, onClose, returnFocusTo, footer: h(Button, { primary: true, disabled: pending || !dirty, onClick: () => onSave(draft) }, t('executionSave')) },
            h('div', { className: 'lanw-execution-dialog-content lanw-stack', 'data-execution-tool-dialog': tool.id },
              problem && h('p', { className: 'lanw-error', role: 'alert' }, problem),
              h('p', { className: 'lanw-help' }, tool.description), stale && h('p', { className: 'lanw-error' }, t('executionStale')),
              h('div', { className: 'lanw-execution-grants' },
                h(Check, { label: t('executionHarness'), checked: draft.harness, disabled: pending || !tool.enabled, onChange: event => change({ harness: event.target.checked }) }),
                h(Check, { label: t('executionShared'), checked: draft.shared, disabled: pending || !tool.enabled || !!tool.sharingIssue, onChange: event => change({ shared: event.target.checked }) })),
              tool.sharingIssue && h('p', { className: 'lanw-help' }, tool.sharingIssue), !tool.sharingIssue && tool.sharingNote && h('p', { className: 'lanw-help' }, tool.sharingNote), usage,
              h('p', { className: 'lanw-help' }, t('executionSharedNote')), h('p', { className: 'lanw-help' }, t('executionRetireNote'))));
        }
        function SharedExecutionTools({ active, ...props }) {
          const [loaded, setLoaded] = React.useState(active);
          const [tab, setTab] = React.useState('manual');
          const tabs = [['manual', 'executionManualTab'], ['scanned', 'executionScannedTab']];
          React.useEffect(() => { if (active) setLoaded(true); }, [active]);
          if (!loaded) return null;
          const notes = tab === 'manual' ? ['executionManualHint', 'executionIntro', 'executionSharedNote', 'executionRetireNote'] : ['executionScannedHint', 'executionIntro', 'executionSharedNote', 'executionRetireNote'];
          return h('section', { className: 'lanw-inline-execution', 'data-shared-execution-tools': true, 'aria-label': t('executionToolCatalog') },
            h('div', { className: 'lanw-execution-sectionbar' },
              h('div', { className: 'lanw-execution-tabs', role: 'tablist', 'aria-label': t('executionToolCatalog'), onKeyDown: event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); const next = event.key === 'Home' ? 'manual' : event.key === 'End' ? 'scanned' : tab === 'manual' ? 'scanned' : 'manual';
                setTab(next); event.currentTarget.querySelector(`[data-execution-tab="${next}"]`)?.focus();
              } }, tabs.map(([id, label]) => h(Button, { key: id, id: `lanw-execution-tab-${id}`, role: 'tab', 'data-execution-tab': id, 'aria-selected': tab === id, 'aria-controls': `lanw-execution-panel-${id}`, tabIndex: tab === id ? 0 : -1, onClick: () => setTab(id) }, t(label)))),
              h(Tooltip, { label: h('span', { style: { whiteSpace: 'pre-line' } }, notes.map(key => t(key)).join('\n\n')), side: 'bottom', align: 'end', delayMs: 80, focusDelayMs: 0, maxWidth: 360, openOnClick: true },
                h('button', { type: 'button', className: 'lanw-btn lanw-iconbutton', 'data-execution-help': tab, 'aria-label': `${t(tab === 'manual' ? 'executionManualTab' : 'executionScannedTab')} · ${t('executionNotes')}` }, h(IconInfoOutlineRegular, { size: 16, 'aria-hidden': true, focusable: false })))),
            tabs.map(([id]) => h('section', { key: id, id: `lanw-execution-panel-${id}`, className: 'lanw-execution-panel', role: 'tabpanel', 'aria-labelledby': `lanw-execution-tab-${id}`, hidden: tab !== id }, id === 'manual' ? h(ManualExecutionTools, props) : h(ExecutionToolsManager, props))));
        }
        function ManualExecutionTools(props) {
          return h('section', { 'data-manual-execution-tools': true }, h(CliToolsManager, props));
        }
        function ExecutionMore({ disabled, onExport, onReload }) {
          const [open, setOpen] = React.useState(false), opener = React.useRef(null), menu = React.useRef(null), last = React.useRef(false);
          const id = React.useId();
          const items = [{ id: 'export', label: t('executionExport'), disabled }, { id: 'reload', label: t('reloadSharing'), disabled }];
          React.useEffect(() => {
            const node = menu.current;
            const position = event => {
              if (event.newState !== 'open' || !opener.current) return;
              const rect = opener.current.getBoundingClientRect(), width = Math.min(240, window.innerWidth - 24);
              node.style.width = `${width}px`; node.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
              node.style.top = `${rect.bottom + 84 < window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - 84)}px`;
            };
            const toggle = event => {
              const shown = event.newState === 'open'; setOpen(shown);
              if (shown) { const buttons = node.querySelectorAll('button:not(:disabled)'); buttons[last.current ? buttons.length - 1 : 0]?.focus(); last.current = false; }
            };
            node.addEventListener('beforetoggle', position); node.addEventListener('toggle', toggle);
            return () => { node.removeEventListener('beforetoggle', position); node.removeEventListener('toggle', toggle); };
          }, []);
          return h('span', { className: 'lanw-execution-more' },
            h(Button, { disabled, popovertarget: id, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: event => { opener.current = event.currentTarget; }, onKeyDown: event => {
              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
              event.preventDefault(); last.current = event.key === 'ArrowUp'; event.currentTarget.click();
            } }, t('executionMore')),
            h('div', { ref: menu, id, popover: 'auto', role: 'menu', className: 'lanw-execution-overflow', onKeyDown: event => {
              if (isDismissKey(event)) { event.preventDefault(); event.stopPropagation(); menu.current.hidePopover(); opener.current?.focus({ preventScroll: true }); return; }
              if (event.key === 'Tab') { menu.current.hidePopover(); return; }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
              buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            } }, items.map(item => h(Button, { key: item.id, role: 'menuitem', disabled: item.disabled, onClick: () => { menu.current.hidePopover(); if (item.id === 'export') onExport(); else onReload(); } }, item.label))));
        }
        function ToolPagination({ kind, total, page, pages, size, setPage, setSize, disabled }) {
          return h('div', { className: 'lanw-row lanw-model-footer', 'data-tool-pagination': kind },
            h('span', { className: 'lanw-help' }, `${total} ${t('executionToolsCount')}`),
            h('label', { className: 'lanw-model-size' }, h('span', null, t('toolsPerPage')), h('select', { 'aria-label': t('toolsPerPage'), value: size, disabled, onChange: event => setSize(Number(event.target.value)) }, [5, 10, 20].map(value => h('option', { key: value, value }, value)))),
            h(Pager, { page, pages, setPage, disabled }));
        }
        function CliToolsManager({ request, onSaved, disabled }) {
          const [saved, setSaved] = React.useState(null), [draft, setDraft] = React.useState(null);
          const [page, setPage] = React.useState(0), [size, setSize] = React.useState(5);
          const [target, setTarget] = React.useState(''), identified = React.useRef(null);
          const [manualEntry, setManualEntry] = React.useState(false);
          const [imported, setImported] = React.useState(null), inputFile = React.useRef(null);
          const [editing, setEditing] = React.useState(null), [removing, setRemoving] = React.useState(null);
          const [busy, setBusy] = React.useState(false), [problem, setProblem] = React.useState(''), [notice, setNotice] = React.useState('');
          const blocked = disabled || busy;
          async function load() {
            setBusy(true); setProblem(''); setNotice('');
            try { setSaved(await request('admin.cliTools', { operation: 'read' })); setPage(0); setDraft(null); setImported(null); setEditing(null); setRemoving(null); }
            catch (error) { setProblem(error.message); }
            finally { setBusy(false); }
          }
          React.useEffect(() => { load(); }, []);
          const change = fields => { setDraft(old => ({ ...old, ...fields })); setProblem(''); setNotice(''); };
          function edit(tool, index) {
            setEditing(index); setRemoving(null); setProblem(''); setNotice(''); setTarget(''); setManualEntry(false); identified.current = null;
            setDraft({ id: tool?.id ?? '', label: tool?.label ?? '', command: tool?.command ?? '', enabled: tool?.enabled !== false,
              args: [...(tool?.args ?? [])], paths: (tool?.readOnlyPaths ?? []).join('\n'),
              environment: Object.entries(tool?.environment ?? {}), credentials: Object.entries(tool?.credentials ?? {}) });
          }
          async function inspectTarget() {
            if (blocked || !target.trim()) return;
            setBusy(true); setProblem(''); setNotice('');
            try {
              const { tool } = await request('admin.cliTools', { operation: 'inspect', target: target.trim() });
              const last = identified.current;
              setDraft(previous => ({ ...previous, id: !previous.id || previous.id === last?.id ? tool.id : previous.id,
                label: !previous.label || previous.label === last?.label ? tool.label : previous.label, command: tool.command, paths: tool.readOnlyPaths.join('\n') }));
              identified.current = tool;
              setNotice(t('cliInspected'));
            } catch (error) { setProblem(error.message); } finally { setBusy(false); }
          }
          function dictionary(rows) {
            const result = {};
            for (const [raw, value] of rows) {
              const name = raw.trim();
              if (!name || Object.hasOwn(result, name)) throw new Error(t('cliDuplicateVariable'));
              Object.defineProperty(result, name, { value, enumerable: true, configurable: true });
            }
            return result;
          }
          async function importFile(event) {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            try {
              if (file.size > 128 * 1024) throw new Error(t('executionConfigError'));
              const value = JSON.parse(await file.text());
              if (value.format !== 'dsh-execution-tools' || value.version !== 1 || !Array.isArray(value.tools) || !value.executionTools || Object.keys(value).some(key => !['format', 'version', 'tools', 'executionTools'].includes(key))) throw new Error(t('executionConfigError'));
              setImported(value); setProblem(''); setNotice(t('executionImportReady'));
            } catch { setProblem(t('executionConfigError')); }
          }
          async function persist(tools, executionTools) {
            setBusy(true); setProblem(''); setNotice('');
            try {
              const result = await request('admin.cliTools', { operation: 'save', expectedRevision: saved.revision, tools, ...(executionTools ? { executionTools } : {}) });
              setSaved(result); setDraft(null); setImported(null); setEditing(null); setRemoving(null); setNotice(t('cliSaved'));
              try { await onSaved(); } catch (error) { setProblem(error.message); }
            } catch (error) { setProblem(error.message); }
            finally { setBusy(false); }
          }
          function submit(event) {
            event.preventDefault();
            if (blocked) return;
            try {
              const tool = { id: draft.id.trim(), label: draft.label.trim() || draft.id.trim(), command: draft.command.trim(), enabled: draft.enabled,
                args: draft.args, readOnlyPaths: draft.paths.split('\n').map(path => path.trim()).filter(Boolean),
                environment: dictionary(draft.environment), credentials: dictionary(draft.credentials) };
              const tools = [...saved.tools];
              if (editing === -1) tools.push(tool); else tools[editing] = tool;
              void persist(tools);
            } catch (error) { setProblem(error.message); }
          }
          function pairFields(key, label, valueLabel, addLabel) {
            return h('div', { className: 'lanw-stack' }, h('strong', null, t(label)),
              draft[key].map(([name, value], index) => h('div', { key: index, className: 'lanw-cli-pair' },
                h('input', { 'aria-label': `${t('cliVariable')} ${index + 1}`, value: name, placeholder: 'VARIABLE_NAME', onChange: event => change({ [key]: draft[key].map((row, i) => i === index ? [event.target.value, row[1]] : row) }) }),
                h('input', { 'aria-label': `${t(valueLabel)} ${index + 1}`, value, placeholder: t(valueLabel), autoComplete: 'off', onChange: event => change({ [key]: draft[key].map((row, i) => i === index ? [row[0], event.target.value] : row) }) }),
                h(Button, { 'aria-label': `${t('cliRemove')} ${t(label)} ${index + 1}`, onClick: () => change({ [key]: draft[key].filter((_, i) => i !== index) }) }, t('cliRemove')))),
              h(Button, { className: 'lanw-cli-add-row', onClick: () => change({ [key]: [...draft[key], ['', '']] }) }, t(addLabel)));
          }
          const showConfiguration = Boolean(draft && (editing !== -1 || manualEntry || draft.command));
          const pages = Math.max(1, Math.ceil((saved?.tools.length ?? 0) / size)), current = Math.min(page, pages - 1);
          React.useEffect(() => { setPage(previous => Math.min(previous, pages - 1)); }, [pages]);
          return h('div', { className: 'lanw-stack lanw-cli-manager', 'data-cli-manager': true, 'aria-busy': busy },
            !draft && h('div', { className: 'lanw-execution-toolbar' }, h(Button, { primary: true, disabled: blocked || !saved, onClick: () => edit(null, -1) }, t('cliAdd')),
              h(Button, { disabled: blocked || !saved, onClick: () => inputFile.current?.click() }, t('executionImport')),
              h(ExecutionMore, { disabled: blocked || !saved, onExport: () => downloadExecutionConfiguration(saved), onReload: load }),
              h('input', { type: 'file', accept: '.json,application/json', ref: inputFile, hidden: true, 'aria-label': t('executionImport'), onChange: importFile })),
            problem && h('p', { className: 'lanw-error', role: 'alert' }, problem),
            notice && h('p', { className: 'lanw-help', role: 'status' }, notice),
            imported && h('div', { className: 'lanw-stack', 'data-execution-import-preview': true },
              h('p', { className: 'lanw-help' }, `CLI: ${imported.tools.length} · ${t('executionSources')}: ${Array.isArray(imported.executionTools.sources) ? imported.executionTools.sources.length : '—'} · ${t('executionSave')}: ${Array.isArray(imported.executionTools.grants) ? imported.executionTools.grants.length : '—'}`),
              h('div', { className: 'lanw-row' }, h(Button, { primary: true, disabled: blocked, onClick: () => persist(imported.tools, imported.executionTools) }, t('executionImportSave')), h(Button, { disabled: blocked, onClick: () => setImported(null) }, t('cancel')))),
            !saved && !problem && h('p', { className: 'lanw-help' }, t('loading')),
            !draft && saved && (saved.tools.length ? h('div', { className: 'lanw-stack' }, saved.tools.map((tool, index) => ({ tool, index })).slice(current * size, (current + 1) * size).map(({ tool, index }) => h('div', { className: 'lanw-cli-card', key: tool.id, 'data-cli-tool': tool.id },
              h('div', { className: 'lanw-row' }, h('div', { className: 'lanw-cli-summary' }, h('strong', null, tool.label), h('span', { className: 'lanw-cli-meta' }, h('code', null, tool.id), h('span', { className: 'lanw-cli-path' }, tool.command))),
                tool.enabled === false && h('span', { className: 'lanw-help' }, t('cliDisabled')),
                h(Button, { disabled: blocked, onClick: () => edit(tool, index), 'aria-label': `${t('edit')} ${tool.label}` }, t('edit')),
                h(Button, { disabled: blocked, onClick: () => setRemoving(index), 'aria-label': `${t('cliRemove')} ${tool.label}` }, t('cliRemove'))),
              removing === index && h('div', { className: 'lanw-stack' }, h('p', { className: 'lanw-help' }, t('cliRemoveConfirm')), h('p', { className: 'lanw-help' }, t('cliSaveNote')),
                h('div', { className: 'lanw-row' }, h(Button, { primary: true, disabled: blocked, onClick: () => persist(saved.tools.filter((_, i) => i !== index)) }, t('cliConfirmRemove')), h(Button, { disabled: blocked, onClick: () => setRemoving(null) }, t('cancel'))))))) : h('p', { className: 'lanw-empty' }, t('cliNoTools'))),
            !draft && saved && h(ToolPagination, { kind: 'manual', total: saved.tools.length, page: current, pages, size, disabled: blocked, setPage, setSize: value => { setSize(value); setPage(0); } }),
            draft && h('form', { onSubmit: submit, 'data-cli-editor': true }, h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: blocked },
              editing === -1 && h('div', { className: 'lanw-stack', 'data-cli-target': true },
                h(Field, { label: t('cliTarget'), description: t('cliTargetNote'), value: target, maxLength: 4096, placeholder: 'rg',
                  onChange: event => { setTarget(event.target.value); setProblem(''); setNotice(''); },
                  onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229) { event.preventDefault(); void inspectTarget(); } } }),
                h('div', { className: 'lanw-row' }, h(Button, { primary: !showConfiguration, disabled: blocked || !target.trim(), onClick: inspectTarget }, t('cliInspect')),
                  !showConfiguration && h(Button, { disabled: blocked, onClick: () => setManualEntry(true) }, t('cliConfigureManually')))),
              showConfiguration && h('div', { className: 'lanw-stack' }, h('div', { className: 'lanw-cli-grid' }, h(Field, { label: t('cliCommandName'), name: 'cli-id', value: draft.id, required: true, maxLength: 64, placeholder: 'smart-search', onChange: event => change({ id: event.target.value }) }),
                h(Field, { label: t('cliDisplayName'), name: 'cli-label', value: draft.label, maxLength: 120, placeholder: 'Smart Search', onChange: event => change({ label: event.target.value }) })),
              h(Field, { label: t('cliProgram'), description: t('cliProgramNote'), name: 'cli-command', value: draft.command, required: true, placeholder: '/usr/bin/python3', onChange: event => change({ command: event.target.value }) }),
              h(FeatureToggle, { label: t('cliEnabled'), checked: draft.enabled, onChange: event => change({ enabled: event.target.checked }) }),
              h('div', { className: 'lanw-stack' }, h('strong', null, t('cliArguments')), draft.args.map((arg, index) => h('div', { className: 'lanw-cli-argument', key: index },
                h('input', { 'aria-label': `${t('cliArgument')} ${index + 1}`, value: arg, onChange: event => change({ args: draft.args.map((item, i) => i === index ? event.target.value : item) }) }),
                h(Button, { 'aria-label': `${t('cliRemove')} ${t('cliArgument')} ${index + 1}`, onClick: () => change({ args: draft.args.filter((_, i) => i !== index) }) }, t('cliRemove')))),
                h(Button, { className: 'lanw-cli-add-row', onClick: () => change({ args: [...draft.args, ''] }) }, t('cliAddArgument'))),
              h(Field, { label: t('cliPaths'), description: t('cliPathsNote') }, h('textarea', { name: 'cli-paths', rows: 3, value: draft.paths, placeholder: '/srv/dsh-tools/smart-search', onChange: event => change({ paths: event.target.value }) }))),
              showConfiguration && h('details', { className: 'lanw-cli-advanced' }, h('summary', null, t('cliAdvanced')), h('div', { className: 'lanw-stack' },
                pairFields('environment', 'cliEnvironment', 'cliValue', 'cliAddVariable'), h('p', { className: 'lanw-help' }, t('cliCredentialNote')), pairFields('credentials', 'cliCredentials', 'cliReference', 'cliAddCredential'))),
              showConfiguration && h('p', { className: 'lanw-help' }, t('cliSaveNote')),
              h('div', { className: 'lanw-row' }, showConfiguration && h(Button, { type: 'submit', primary: true }, t('save')), h(Button, { onClick: () => { setDraft(null); setEditing(null); setProblem(''); setNotice(''); } }, t('cancel')), showConfiguration && h(Button, { onClick: load }, t('reloadSharing'))))));
        }
        const capabilitySections = [['features', 'personalFunctions'], ['skills', 'accessSkills'], ['cliTools', 'accessCliTools'], ['mcpServers', 'accessMcp'], ['agentPresets', 'accessAgents'], ['plugins', 'accessPlugins'], ['permissionPresets', 'accessPermissions']];
        function CapabilityTabs({ active, onSelect, disabled, personal = false }) {
          return h('nav', { className: 'lanw-tabs lanw-capability-tabs', 'data-capability-tabs': personal ? 'personal' : 'administrator', 'aria-label': t(personal ? 'personalTab' : 'accessCapabilities') }, capabilitySections.map(([id, label]) => h(Button, {
            key: id, disabled, [personal ? 'data-personal-section' : 'data-capability-section']: id, 'aria-current': active === id ? 'page' : undefined, onClick: () => onSelect(id),
          }, h(NavigationLabel, { id }, t(label)))));
        }
        function CapabilityChoices({ catalog, selected, onChange, name, disabled, hidden }) {
          return h('fieldset', { className: 'lanw-fieldset lanw-capability-resources', disabled, hidden }, catalog.map(row => h(Check, {
            key: row.id, label: `${row.label ?? row.name ?? row.id}${row.memberIsolated === false ? ` · ${t('resourceNotIsolated')}` : ''}`, name, value: row.id, disabled: row.memberIsolated === false, checked: selected === null || selected.includes(row.id), onChange: event => onChange(row.id, event.target.checked),
          })));
        }
        function PersonalCapabilities({ value, pending, onSave, onReload }) {
          const copy = access => Object.fromEntries(Object.entries(access).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item]));
          const [draft, setDraft] = React.useState(() => copy(value.selection));
          const [revision, setRevision] = React.useState(value.revision), [baseline, setBaseline] = React.useState(() => JSON.stringify(value.selection));
          const [section, setSection] = React.useState('features'), [problem, setProblem] = React.useState(''), [reloading, setReloading] = React.useState(false);
          const previous = React.useRef({});
          const dirty = JSON.stringify(draft) !== baseline, conflict = value.revision !== revision, blocked = pending || reloading;
          React.useEffect(() => { if (!dirty && value.revision !== revision) { setDraft(copy(value.selection)); setRevision(value.revision); setBaseline(JSON.stringify(value.selection)); } }, [value.revision, revision, dirty]);
          async function save(event) {
            event.preventDefault(); if (blocked || !dirty || conflict) return;
            const access = copy(draft);
            for (const [key, ids] of Object.entries(access)) if (Array.isArray(ids) && Array.isArray(value.granted[key]) && (key !== 'tools' || access.toolMode !== 'blacklist' && value.granted.toolMode === 'whitelist')) access[key] = ids.filter(id => value.granted[key].includes(id));
            if (await onSave({ access, expectedRevision: revision })) { setDraft(access); setBaseline(JSON.stringify(access)); setRevision(revision + 1); }
          }
          async function reload() {
            if (blocked) return; setReloading(true); setProblem('');
            try { const next = await onReload(); setDraft(copy(next.selection)); setRevision(next.revision); setBaseline(JSON.stringify(next.selection)); previous.current = {}; }
            catch (error) { setProblem(error.message || t('requestFailed')); }
            finally { setReloading(false); }
          }
          const resources = list(value.catalog?.[section]), selected = draft[section];
          const enabled = resources.length > 0 && (selected === null || resources.some(row => list(selected).includes(row.id)));
          return h('form', { className: 'lanw-personal lanw-capability-settings lanw-stack', 'data-personal-capabilities': true, onSubmit: save, 'aria-busy': blocked },
            h('p', { className: 'lanw-help' }, t('personalScope')),
            value.directoryBoundary?.enforced && h('p', { className: 'lanw-help', 'data-member-boundary': true, role: value.directoryBoundary.available ? undefined : 'status' }, t(value.directoryBoundary.available ? 'memberBoundaryNote' : 'memberBoundaryUnavailable')),
            h(CapabilityTabs, { active: section, onSelect: setSection, disabled: blocked, personal: true }),
            section === 'features' ? h('div', { className: 'lanw-stack', 'data-personal-panel': 'features' }, ['terminal', 'files', 'attachments', 'tasks', 'subagents', 'interactions'].map(key => h(FeatureToggle, {
              key, label: t(`capability${key[0].toUpperCase()}${key.slice(1)}`), description: value.granted[key] === false ? t('personalAdminOff') : undefined,
              checked: value.granted[key] !== false && draft[key] !== false, disabled: blocked || value.granted[key] === false, onChange: event => setDraft(old => ({ ...old, [key]: event.target.checked })),
            })))
              : h('div', { className: 'lanw-stack', 'data-personal-panel': section },
                h('div', { className: 'lanw-setting-row' }, h('div', null, h('span', null, t(capabilitySections.find(([id]) => id === section)[1])), h('p', { className: 'lanw-help' }, `${t('personalSelected')} ${enabled ? resources.filter(row => selected === null || list(selected).includes(row.id)).length : 0} / ${resources.length}`)),
                  h(Switch, { label: t('personalEnabled'), checked: enabled, disabled: blocked || !resources.length, onChange: next => { if (!next) previous.current[section] = draft[section]; setDraft(old => ({ ...old, [section]: next ? previous.current[section] ?? null : [] })); } })),
                !resources.length && h('p', { className: 'lanw-help' }, t('personalNoResources')),
                h(CapabilityChoices, { catalog: resources, selected: enabled ? selected : [], name: `personal.${section}`, disabled: blocked || !enabled, onChange: (id, checked) => setDraft(old => {
                  const ids = old[section] === null ? resources.map(item => item.id) : list(old[section]);
                  const next = checked ? [...new Set([...ids, id])] : ids.filter(item => item !== id);
                  return { ...old, [section]: next.length === resources.length && resources.every(item => next.includes(item.id)) ? null : next };
                }) })),
            conflict && h('p', { className: 'lanw-notice', role: 'alert' }, t('personalConflict')),
            problem && h('p', { className: 'lanw-notice', role: 'alert' }, problem),
            h('p', { className: 'lanw-help' }, t('personalApplyNote')),
            h('div', { className: 'lanw-row lanw-personal-footer' }, h(Button, { type: 'submit', primary: true, disabled: blocked || !dirty || conflict, 'data-save-personal': true }, t('personalSave')),
              h(Button, { disabled: blocked || conflict, onClick: () => setDraft(Object.fromEntries(Object.entries(draft).map(([key, item]) => [key, typeof item === 'boolean' ? true : null]))) }, t('personalDefaults')),
              h(Button, { disabled: blocked, onClick: reload }, t('personalReload'))));
        }
        function Card({ title, children, className = '', ...props }) {
          return h('section', { ...props, className: `lanw-card ${className}` }, title && h('h2', null, title), children);
        }
        function PasswordSettings({ run, pending }) {
          const [problem, setProblem] = React.useState('');
          return h('details', { className: 'lanw-password-settings', 'data-self-password': true }, h('summary', null, t('changePassword')),
            h('p', { className: 'lanw-help' }, t('passwordChangeNote')),
            h('form', { className: 'lanw-stack', onSubmit: async event => {
              event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
              if (data.get('password') !== data.get('confirmPassword')) { setProblem('passwordMismatch'); return; }
              setProblem('');
              if (await run('password.change', { currentPassword: data.get('currentPassword'), password: data.get('password') })) form.reset();
            } }, h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: pending },
              h(Field, { label: t('currentPassword'), name: 'currentPassword', type: 'password', required: true, maxLength: 1024, autoComplete: 'current-password' }),
              h(Field, { label: t('longPassword'), name: 'password', type: 'password', required: true, minLength: 16, maxLength: 1024, autoComplete: 'new-password' }),
              h(Field, { label: t('confirmPassword'), name: 'confirmPassword', type: 'password', required: true, minLength: 16, maxLength: 1024, autoComplete: 'new-password' }),
              problem && h('p', { role: 'alert', className: 'lanw-error' }, t(problem)), h(Button, { type: 'submit', primary: true, disabled: pending }, t(pending ? 'pending' : 'changePassword')))));
        }
        function InviteLink({ memberUrl, inviteToken }) {
          const input = React.useRef(null), [message, setMessage] = React.useState('');
          const url = memberUrl ? `${memberUrl}#invite=${encodeURIComponent(inviteToken)}` : inviteToken;
          async function copy(event) {
            try {
              if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(url);
              else { input.current?.select(); if (!event.currentTarget.ownerDocument.execCommand?.('copy')) throw Error('Manual copy required'); }
              setMessage('linkCopied');
            } catch { input.current?.select(); setMessage('linkSelectCopy'); }
          }
          return h('div', { className: 'lanw-stack', 'data-invite-link': true }, h(Field, { label: t(memberUrl ? 'inviteLink' : 'inviteToken') }, h('input', { ref: input, readOnly: true, value: url, autoComplete: 'off', spellCheck: false, onFocus: event => event.target.select() })),
            h('div', { className: 'lanw-row' }, h(Button, { onClick: copy }, t('copyInviteLink')), message && h('span', { role: 'status', className: 'lanw-help' }, t(message))));
        }
        let memberPickerId = 0;
        function MemberPicker({ users, userPage, request, value, onSelect, label, disabled, allowAll = false, testId, active = true, exclude = '', clearOnSearch = false, includeHistory = false }) {
          const [open, setOpen] = React.useState(false), [query, setQuery] = React.useState(''), [highlight, setHighlight] = React.useState(0), [result, setResult] = React.useState(null), [pending, setPending] = React.useState(false), [problem, setProblem] = React.useState(''), [retry, setRetry] = React.useState(0);
          const sequence = React.useRef(0), chosen = React.useRef(null), listId = React.useRef(null), optionList = React.useRef(null);
          listId.current ??= `lanw-member-choices-${++memberPickerId}`;
          const key = query.trim(), current = result?.key === key ? result.value : !key ? { items: users, total: userPage?.total ?? users.length } : null;
          const rows = (current?.items ?? []).filter(row => row.id !== exclude);
          const selected = rows.find(row => row.id === value) || users.find(row => row.id === value) || (chosen.current?.id === value ? chosen.current : null);
          if (selected) chosen.current = selected;
          const choices = [...(allowAll && !key ? [null] : []), ...(!key && selected && !rows.some(row => row.id === selected.id) ? [selected] : []), ...rows];
          const highlighted = Math.min(highlight, choices.length - 1);
          React.useEffect(() => { if (open && highlighted >= 0) optionList.current?.children[highlighted]?.scrollIntoView?.({ block: 'nearest' }); }, [open, highlighted, key, result]);
          const accountState = row => row.deletedAt != null ? t('deletedAccount') : row.archivedAt != null ? t('archivedAccount') : row.disabled ? t('disabledState') : '';
          const display = row => row ? `${row.displayName} · @${row.username}${accountState(row) ? ' · ' + accountState(row) : ''}` : allowAll ? t('contentAllUsers') : '';
          function choose(row) { chosen.current = row; onSelect(row); setOpen(false); setQuery(''); setHighlight(0); }
          function showOptions() { setOpen(true); setQuery(''); setHighlight(Math.max(0, choices.findIndex(row => (row?.id ?? '') === (value ?? '')))); }
          React.useEffect(() => {
            const generation = ++sequence.current;
            if (!active || !open) { setPending(false); setProblem(''); return; }
            setPending(true); setProblem('');
            const timer = setTimeout(async () => {
              try {
                const next = await request('admin.listUsers', { query: key, page: 0, pageSize: 50, status: 'all', summary: true, ...(includeHistory ? { includeHistory: true } : {}) });
                if (!Array.isArray(next.items) || !Number.isSafeInteger(next.total)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                if (generation === sequence.current) setResult({ key, value: next });
              } catch (error) { if (generation === sequence.current) setProblem(error.message || t('requestFailed')); }
              finally { if (generation === sequence.current) setPending(false); }
            }, 150);
            return () => { clearTimeout(timer); sequence.current++; };
          }, [active, open, key, request, retry, includeHistory]);
          return h('div', { className: 'lanw-member-picker', 'data-member-picker': true, 'aria-busy': pending, onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(''); } } },
            h('input', { role: 'combobox', value: open ? query : display(selected), disabled, placeholder: t('memberPickerHint'), autoComplete: 'off', 'aria-label': label,
              'aria-expanded': open, 'aria-autocomplete': 'list', 'aria-controls': listId.current, 'aria-activedescendant': open && highlighted >= 0 ? `${listId.current}-${highlighted}` : undefined,
              'data-member-picker-search': true, 'data-member-value': value ?? '', [testId || 'data-member-picker-select']: true,
              onFocus: showOptions, onClick: () => { if (!open) showOptions(); },
              onChange: event => { setQuery(event.target.value); setOpen(true); setHighlight(0); if (clearOnSearch) onSelect(null); },
              onKeyDown: event => {
                if (isDismissKey(event) && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); return; }
                if (event.nativeEvent?.isComposing) return;
                if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); setHighlight(previous => !open ? 0 : (previous + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, choices.length)) % Math.max(1, choices.length)); }
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!open) showOptions(); else if (highlighted >= 0 && !(pending && key)) choose(choices[highlighted]); }
              } }),
            open && h('div', { className: 'lanw-member-options', onMouseDown: event => event.preventDefault() },
              h('div', { ref: optionList, role: 'listbox', id: listId.current, 'aria-label': label }, choices.map((row, index) => h('button', { type: 'button', role: 'option', id: `${listId.current}-${index}`, key: row?.id ?? 'all', 'data-member-option': row?.id ?? '', 'data-active': highlighted === index, 'aria-selected': (row?.id ?? '') === (value ?? ''), disabled: disabled || Boolean(pending && key), onMouseEnter: () => setHighlight(index), onClick: () => choose(row) },
                h('span', null, row?.displayName ?? t('contentAllUsers')), row && h('small', null, `@${row.username}${accountState(row) ? ' · ' + accountState(row) : ''}`)))),
              pending && h('p', { className: 'lanw-help', role: 'status' }, t('loading')),
              !pending && !problem && !choices.length && h('p', { className: 'lanw-help' }, t('noAccountMatches')),
              current?.total > 50 && h('p', { className: 'lanw-help' }, t('memberTooMany')),
              problem && h('div', { role: 'alert', className: 'lanw-help lanw-error' }, problem, h(Button, { disabled: pending || disabled, onClick: () => setRetry(value => value + 1) }, t('retry')))));
        }
        function GrantCopy({ users, userPage, request, onCopy, disabled, exclude, compact = false }) {
          const [source, setSource] = React.useState(''), [pending, setPending] = React.useState(false), [message, setMessage] = React.useState('');
          const alive = React.useRef(true), lock = React.useRef(false);
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
          async function copy() {
            if (!source || pending || lock.current || disabled) return;
            lock.current = true; setPending(true); setMessage('');
            try { const result = await request('admin.getUser', { userId: source }); if (alive.current) { onCopy(result.user); setMessage(t('grantsCopied')); } }
            catch (error) { if (alive.current) setMessage(error.message || t('requestFailed')); }
            finally { lock.current = false; if (alive.current) setPending(false); }
          }
          return h('div', { className: 'lanw-grant-copy', 'data-grant-copy': true }, !compact && h('span', { className: 'lanw-help' }, t('copyGrants')), h('div', { className: 'lanw-row' },
            h(MemberPicker, { users, userPage, request, exclude, clearOnSearch: true, value: source, disabled: disabled || pending, label: t('chooseGrantSource'), onSelect: row => { setSource(row?.id ?? ''); setMessage(''); } }),
            h(Button, { disabled: disabled || pending || !source, onClick: copy }, t(pending ? 'pending' : 'applyGrantCopy'))), (message || !compact) && h('p', { className: 'lanw-help', role: message ? 'status' : undefined }, message || t('grantCopyNote')));
        }
        function EffectiveAccess({ userId, revision, request }) {
          const [open, setOpen] = React.useState(false), [value, setValue] = React.useState(null), [pending, setPending] = React.useState(false), [problem, setProblem] = React.useState('');
          const epoch = React.useRef(0);
          async function load() {
            const current = ++epoch.current; setPending(true); setProblem('');
            try { const result = await request('admin.getUser', { userId }); if (!result.preferences || result.user?.id !== userId) throw Error(t('invalidResponse')); if (current === epoch.current) setValue(result); }
            catch (error) { if (current === epoch.current) setProblem(error.message || t('requestFailed')); }
            finally { if (current === epoch.current) setPending(false); }
          }
          React.useEffect(() => { if (open) void load(); return () => { epoch.current++; }; }, [open, userId, revision]);
          const scope = (value, key, policy) => key === 'tools' ? `${t((policy.toolMode ?? (Array.isArray(value) ? 'whitelist' : 'blacklist')) === 'whitelist' ? 'toolWhitelist' : 'toolBlacklist')} · ${value?.length ? value.join(', ') : t('scopeNone')}` : typeof value === 'boolean' ? t(value ? 'scopeEnabled' : 'scopeDisabled') : value === null ? t('scopeAll') : value?.length ? value.join(', ') : t('scopeNone');
          const reason = key => {
            if (value.user.disabled) return t('accountUnavailable');
            const grant = value.preferences.granted[key], selection = value.preferences.selection[key];
            if (key === 'tools') {
              const limited = policy => (policy.toolMode ?? (Array.isArray(policy.tools) ? 'whitelist' : 'blacklist')) === 'whitelist' || list(policy.tools).length > 0;
              return [limited(value.preferences.granted) ? t('grantLimited') : '', limited(value.preferences.selection) ? t('personallyLimited') : ''].filter(Boolean).join(' · ');
            }
            return [grant === false || Array.isArray(grant) ? t('grantLimited') : '', selection === false || Array.isArray(selection) ? t('personallyLimited') : ''].filter(Boolean).join(' · ');
          };
          const labels = { terminal: 'capabilityTerminal', files: 'capabilityFiles', attachments: 'capabilityAttachments', tasks: 'capabilityTasks', subagents: 'capabilitySubagents', interactions: 'capabilityInteractions', tools: 'toolNames', skills: 'accessSkills', agentPresets: 'accessAgents', permissionPresets: 'accessPermissions', plugins: 'accessPlugins', mcpServers: 'accessMcp', cliTools: 'accessCliTools' };
          return h('details', { className: 'lanw-effective-access', 'data-effective-access': true, onToggle: event => setOpen(event.currentTarget.open) }, h('summary', null, t('effectiveAccess')),
            open && h('div', { className: 'lanw-stack', 'aria-busy': pending }, h('p', { className: 'lanw-help' }, t('effectiveAccessNote')),
              h(Button, { disabled: pending, onClick: load }, t('refresh')), problem && h('p', { className: 'lanw-error', role: 'alert' }, problem),
              value && h(React.Fragment, null, value.user.disabled && h('p', { role: 'status', className: 'lanw-help' }, t('accountDisabledNote')),
                h('div', { className: 'lanw-tablewrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, t('accessCapabilities')), ...['grantedColumn', 'selectedColumn', 'effectiveColumn'].map(key => h('th', { key }, t(key))))),
                  h('tbody', null, Object.entries(labels).map(([key, label]) => h('tr', { key }, h('th', { scope: 'row' }, t(label)), ...['granted', 'selection', 'effective'].map(field => h('td', { key: field }, scope(value.preferences[field][key], key, value.preferences[field]), field === 'effective' && reason(key) && h('p', { className: 'lanw-help' }, reason(key))))))))),
                h('p', { className: 'lanw-help' }, `${t('effectiveModels')}: ${value.routes.map(row => row.label).join(', ') || t('scopeNone')}`))));
        }
        function InvitationManager({ request, onIssued, refreshKey, disabled }) {
          const [open, setOpen] = React.useState(false), [page, setPage] = React.useState(0), [value, setValue] = React.useState(null), [pending, setPending] = React.useState(false), [problem, setProblem] = React.useState('');
          const epoch = React.useRef(0), alive = React.useRef(true), lock = React.useRef(false);
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
          async function load() {
            const current = ++epoch.current; setPending(true); setProblem('');
            try { const result = await request('admin.listInvites', { page }); if (!Array.isArray(result.items) || !Number.isSafeInteger(result.pages)) throw Error('Invalid invitation list'); if (alive.current && current === epoch.current) setValue(result); }
            catch (error) { if (alive.current && current === epoch.current) setProblem(error.code === 'INVITE_CONFLICT' ? t('inviteConflict') : error.message || t('requestFailed')); }
            finally { if (alive.current && current === epoch.current) setPending(false); }
          }
          React.useEffect(() => { if (open) void load(); }, [open, page, refreshKey]);
          async function change(action, invite) {
            if (lock.current || pending || disabled) return;
            lock.current = true; setPending(true); setProblem('');
            try { const result = await request(action, { inviteId: invite.id, expectedRevision: invite.revision }); if (!alive.current) return; if (action === 'admin.reissueInvite') onIssued(result); await load(); }
            catch (error) { if (alive.current) setProblem(error.code === 'INVITE_CONFLICT' ? t('inviteConflict') : error.message || t('requestFailed')); }
            finally { lock.current = false; if (alive.current) setPending(false); }
          }
          return h('details', { className: 'lanw-invitation-history', 'data-invitation-history': true, onToggle: event => setOpen(event.currentTarget.open) }, h('summary', null, t('invitationHistory')),
            open && h('div', { className: 'lanw-stack', 'aria-busy': pending }, h('p', { className: 'lanw-help' }, t('invitationHistoryNote')),
              problem && h('p', { role: 'alert', className: 'lanw-error' }, problem), h(Button, { disabled: pending || disabled, onClick: load }, t('refresh')),
              value ? h(React.Fragment, null, value.items.length ? h('div', { className: 'lanw-invitation-list' }, value.items.map(invite => h('div', { key: invite.id, className: 'lanw-invitation-row' },
                h('div', null, h('strong', null, invite.displayName || t('memberRole')), h('p', { className: 'lanw-help' }, `${t({ pending: 'invitePending', used: 'inviteUsed', expired: 'inviteExpired', revoked: 'inviteRevoked' }[invite.status])} · ${new Date(invite.usedAt ?? invite.revokedAt ?? invite.expiresAt).toLocaleString()}`)),
                h('div', { className: 'lanw-row' }, invite.status === 'pending' && h(Button, { disabled: pending || disabled, onClick: () => change('admin.revokeInvite', invite) }, t('revokeInvite')), h(Button, { disabled: pending || disabled, onClick: () => change('admin.reissueInvite', invite) }, t('reissueInvite')))))) : h('p', { className: 'lanw-help' }, t('invitationEmpty')),
                value.pages > 1 && h(Pager, { page: value.page, pages: value.pages, setPage: next => { if (!pending) setPage(next); } })) : !problem && h('p', { role: 'status' }, t('loading'))));
        }
        function Pager({ page, pages, setPage, disabled = false }) {
          return h('div', { className: 'lanw-row lanw-pager' }, h(Button, { disabled: disabled || page === 0, onClick: () => setPage(page - 1) }, t('previousPage')),
            h('span', { role: 'status' }, `${page + 1} / ${pages}`), h(Button, { disabled: disabled || page + 1 >= pages, onClick: () => setPage(page + 1) }, t('nextPage')));
        }
        function ModelBrowser({ catalog, allowed, onChange }) {
          const [query, setQuery] = React.useState(''), [page, setPage] = React.useState(0), [size, setSize] = React.useState(5), [expanded, setExpanded] = React.useState({});
          const groups = modelGroups(catalog).filter(group => `${group.providerName} ${group.modelName}`.toLowerCase().includes(query.toLowerCase()));
          const pages = Math.max(1, Math.ceil(groups.length / size)), current = Math.min(page, pages - 1), visible = groups.slice(current * size, (current + 1) * size);
          return h('div', { className: 'lanw-model-browser', 'data-model-browser': true },
            h('div', { className: 'lanw-model-tools' }, h('input', { type: 'search', 'aria-label': t('searchModels'), placeholder: t('searchModels'), value: query, onChange: event => { setQuery(event.target.value); setPage(0); } }),
              h('label', { className: 'lanw-model-size' }, h('span', null, t('pageSize')), h('select', { 'aria-label': t('pageSize'), value: size, onChange: event => { setSize(Number(event.target.value)); setPage(0); } }, [5, 10, 20].map(value => h('option', { key: value, value }, value))))),
            h('div', { className: 'lanw-model-list' }, visible.map((group, index) => h(React.Fragment, { key: group.key },
              (index === 0 || visible[index - 1].key.split('\u0000')[0] !== group.key.split('\u0000')[0]) && h('div', { className: 'lanw-model-provider', 'data-model-provider': true }, group.providerName),
              h('details', { 'data-model-row': group.key, open: expanded[group.key] === true, onToggle: event => { const open = event.currentTarget.open; setExpanded(old => old[group.key] === open ? old : { ...old, [group.key]: open }); } },
                h('summary', { title: `${group.providerName} · ${group.modelName}` }, h('svg', { className: 'lanw-model-chevron', width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'm6 3 5 5-5 5' })),
                  h('span', { className: 'lanw-model-name' }, group.modelName), h('span', { className: 'lanw-model-count', title: t(onChange ? 'selectedVariants' : 'effortLevels') }, onChange ? `${group.variants.filter(item => allowed.includes(item.id)).length} / ${group.variants.length}` : `${group.variants.length} ${t('effortLevels')}`)),
                expanded[group.key] && h('div', { className: 'lanw-model-efforts' }, group.variants.map(variant => onChange ? h(Check, { key: variant.id, 'data-variant': variant.id, value: variant.id,
                  label: variant.effortName || variant.reasoningEffort || t('modelDefault'), checked: allowed.includes(variant.id), onChange: event => onChange(variant.id, event.target.checked) }) : h('span', { key: variant.id, className: 'lanw-model-effort' }, variant.effortName || variant.reasoningEffort || t('modelDefault'))))))),
              !groups.length && h('p', { className: 'lanw-model-empty' }, t('noMatches'))),
            h('div', { className: 'lanw-model-footer' }, h('span', null, `${groups.length} ${t('modelsCount')}`), pages > 1 && h(Pager, { page: current, pages, setPage })));
        }
        function ModelPolicy({ catalog, account = {}, panel = false, compact = false }) {
          const [mode, setMode] = React.useState(() => account.modelAccess || (list(account.routeIds).length ? 'custom' : 'inherit'));
          const [allowed, setAllowed] = React.useState(() => list(account.routeIds));
          const [selected, setSelected] = React.useState(() => allowed.includes(account.defaultRouteId) ? account.defaultRouteId : '');
          const [open, setOpen] = React.useState(false);
          const selectedModels = modelGroups(catalog).filter(group => group.variants.some(item => allowed.includes(item.id))).length;
          return h('section', { className: `lanw-stack lanw-access-section${compact ? ' lanw-model-policy-compact' : ''}` }, !panel && !compact && h('h3', null, t('modelsTab')),
            h(Field, { label: t(compact ? 'modelsTab' : 'accessMode') }, h('select', { name: 'modelAccess', value: mode, onChange: event => setMode(event.target.value) },
              h('option', { value: 'inherit' }, t('inheritModels')), h('option', { value: 'custom' }, t('customModels')))),
            h('p', { className: 'lanw-help' }, t(mode === 'inherit' ? 'inheritModelsNote' : 'customModelsNote')),
            h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: mode === 'inherit', hidden: mode === 'inherit' }, allowed.map(id => h('input', { key: id, type: 'hidden', name: 'routeIds', value: id })),
            h('details', { key: 'model-policy', 'data-model-policy': true, open, onToggle: event => setOpen(event.currentTarget.open) }, h('summary', null, `${t('routeAllowlist')} · ${selectedModels} ${t('modelsCount')} / ${allowed.length} ${t('variantsCount')}`),
              open && h(ModelBrowser, { catalog, allowed, onChange(id, checked) { setAllowed(old => checked ? [...new Set([...old, id])] : old.filter(value => value !== id)); if (!checked && selected === id) setSelected(''); } })),
            h(Field, { label: t('defaultRoute') }, h('select', { name: 'defaultRouteId', value: selected, onChange: event => setSelected(event.target.value) }, h('option', { value: '' }, t('noDefault')), catalog.filter(item => allowed.includes(item.id)).map(item => h('option', { key: item.id, value: item.id }, item.label))))));
        }
        function ModelCatalog({ catalog, initiallyOpen = false }) {
          const [open, setOpen] = React.useState(initiallyOpen);
          return h('details', { className: 'lanw-card', 'data-model-catalog': true, open, onToggle: event => setOpen(event.currentTarget.open) }, h('summary', null, `${t('routes')} · ${modelGroups(catalog).length} ${t('modelsCount')} / ${catalog.length} ${t('variantsCount')}`),
            open && h('div', { className: 'lanw-stack' }, h('p', { className: 'lanw-help' }, t('routeNote')), h(ModelBrowser, { catalog })));
        }
        function CapabilityPolicy({ account = {}, tools, panel = false, pending = false }) {
          const access = account.access || {}, flags = ['terminal', 'files', 'attachments', 'tasks', 'subagents', 'interactions'];
          const [enabled, setEnabled] = React.useState(() => flags.filter(key => access[key] !== false)), [expanded, setExpanded] = React.useState(false);
          const [mode, setMode] = React.useState(() => access.toolMode ?? (Array.isArray(access.tools) ? 'whitelist' : 'blacklist'));
          const [selected, setSelected] = React.useState(() => list(access.tools));
          return h(panel ? 'section' : 'details', { className: panel ? 'lanw-policy-pane' : 'lanw-policy', 'data-capability-policy': true, ...(panel ? {} : { open: expanded, onToggle: event => setExpanded(event.currentTarget.open) }) }, h(panel ? 'p' : 'summary', { className: panel ? 'lanw-policy-summary' : undefined }, !panel && h('span', null, t('capabilityAccess')), h('span', { className: 'lanw-policy-state' }, `${enabled.length} / ${flags.length}`)),
            h('div', { className: 'lanw-stack' }, h('div', { className: 'lanw-capability-grid' }, flags.map(key => h(panel ? FeatureToggle : Check, { key, name: `access.${key}`, checked: enabled.includes(key), onChange: event => setEnabled(old => event.target.checked ? [...old, key] : old.filter(value => value !== key)), label: t(`capability${key[0].toUpperCase()}${key.slice(1)}`) }))),
              h(Field, { label: t('toolAccess') }, h('select', { name: 'toolAccess', value: mode, onChange: event => setMode(event.target.value) }, h('option', { value: 'blacklist' }, t('toolBlacklist')), h('option', { value: 'whitelist' }, t('toolWhitelist')))),
              h('p', { className: 'lanw-help', 'data-tool-mode-note': mode }, t(mode === 'blacklist' ? 'toolBlacklistNote' : 'toolWhitelistNote')),
              h('fieldset', { className: 'lanw-fieldset lanw-capability-resources', disabled: pending, 'data-tool-selection': mode },
                [...new Set([...tools, ...selected])].sort().map(name => h(Check, { key: name, name: 'toolNames', value: name, checked: selected.includes(name), label: name, onChange: event => setSelected(old => event.target.checked ? [...old, name] : old.filter(value => value !== name)) })))));
        }
        function ResourcePolicy({ account = {}, catalog, complete, field = 'skills', panel = false }) {
          const [attribute, names, title, inheritLabel, customLabel, note] = {
            skills: ['skill', 'skillNames', 'skillAccess', 'inheritSkills', 'customSkills', 'skillsNote'],
            agentPresets: ['agent-preset', 'agentPresetNames', 'agentPresetAccess', 'inheritAgentPresets', 'customAgentPresets', 'agentPresetsNote'],
            permissionPresets: ['permission-preset', 'permissionPresetNames', 'permissionPresetAccess', 'inheritPermissionPresets', 'customPermissionPresets', 'permissionPresetsNote'],
            plugins: ['plugin', 'pluginNames', 'pluginAccess', 'inheritPlugins', 'customPlugins', 'pluginsNote'],
            mcpServers: ['mcp-server', 'mcpServerNames', 'mcpAccess', 'inheritMcp', 'customMcp', 'mcpNote'],
            cliTools: ['cli', 'cliNames', 'cliAccess', 'inheritCli', 'customCli', 'cliNote'],
          }[field];
          const [custom, setCustom] = React.useState(() => Array.isArray(account.access?.[field]));
          const [selected, setSelected] = React.useState(() => list(account.access?.[field]));
          const rows = new Map(catalog.map(row => [row.id, row]));
          for (const id of selected) if (!rows.has(id)) rows.set(id, { id, label: id });
          return h(panel ? 'section' : 'details', { className: panel ? 'lanw-policy-pane' : 'lanw-policy', [`data-${attribute}-policy`]: true }, h(panel ? 'p' : 'summary', { className: panel ? 'lanw-policy-summary' : undefined }, !panel && h('span', null, t(title)), h('span', { className: 'lanw-policy-state' }, custom ? `${t('customSummary')} · ${selected.length}` : t('inheritSummary'))),
            h('div', { className: 'lanw-stack' },
              ['plugins', 'mcpServers'].includes(field) && catalog.some(row => row.memberIsolated === false) && h('p', { className: 'lanw-help', 'data-resource-boundary': true }, t('memberBoundaryNote')),
              h(Field, { label: t(panel ? 'accessMode' : title) }, h('select', { name: field + 'Mode', value: custom ? 'custom' : 'inherit', onChange: event => setCustom(event.target.value === 'custom') }, h('option', { value: 'inherit' }, t(inheritLabel)), h('option', { value: 'custom' }, t(customLabel)))),
              custom && h('p', { className: 'lanw-help' }, t(note)),
              field === 'mcpServers' && !catalog.length && h('p', { className: 'lanw-help' }, t('noMcpServers')),
              field === 'cliTools' && !catalog.length && h('p', { className: 'lanw-help' }, t('cliEmpty')),
              complete === false && h('p', { className: 'lanw-help', role: 'status' }, t(field === 'plugins' ? 'pluginDiscoveryIncomplete' : 'skillDiscoveryIncomplete')),
              h(CapabilityChoices, { catalog: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), selected, name: names, disabled: !custom, hidden: !custom, onChange: (id, checked) => setSelected(old => checked ? [...old, id] : old.filter(value => value !== id)) })));
        }
        function AdministratorCapabilities({ account, catalog, pending }) {
          const [section, setSection] = React.useState('features');
          const catalogs = { skills: ['skillCatalog', catalog.skillCatalogComplete], cliTools: ['cliCatalog'], mcpServers: ['mcpCatalog'], agentPresets: ['agentPresetCatalog'], plugins: ['pluginCatalog', list(catalog.unAttributedTools).length === 0], permissionPresets: ['permissionPresetCatalog'] };
          return h('div', { className: 'lanw-stack lanw-capability-settings', 'data-admin-capabilities': true },
            h(CapabilityTabs, { active: section, onSelect: setSection, disabled: pending }),
            capabilitySections.map(([id]) => h('section', { key: id, hidden: section !== id, 'data-capability-panel': id }, id === 'features'
              ? h(CapabilityPolicy, { account, panel: true, pending, tools: list(catalog.toolCatalog) })
              : h(ResourcePolicy, { account, panel: true, field: id, catalog: list(catalog[catalogs[id][0]]), complete: catalogs[id][1] }))));
        }
        function DirectoryPolicy({ account = {}, panel = false, recommendedPath, onRecommended }) {
          const [rows, setRows] = React.useState(() => list(account.access?.sharedDirectories));
          const change = (index, fields) => setRows(old => old.map((row, i) => i === index ? { ...row, ...fields } : row));
          return h(panel ? 'section' : 'details', { className: panel ? 'lanw-policy-pane' : 'lanw-policy', 'data-directory-policy': true }, h(panel ? 'p' : 'summary', { className: panel ? 'lanw-policy-summary' : undefined }, !panel && h('span', null, t('sharedDirectories')), h('span', { className: 'lanw-policy-state' }, rows.length ? `${rows.length} ${t('directoryCount')}` : t('personalDirectoryOnly'))),
            h('input', { type: 'hidden', name: 'sharedDirectories', value: JSON.stringify(rows) }),
            h('div', { className: 'lanw-stack' }, h('p', { className: 'lanw-help' }, t('sharedDirectoriesNote')),
              rows.map((row, index) => h('div', { key: index, className: 'lanw-stack', 'data-directory-row': index },
                h(Field, { label: t('directoryPath') }, h('input', { value: row.path, required: true, placeholder: '/srv/shared', onChange: event => change(index, { path: event.target.value }) })),
                h(Field, { label: t('directoryMode') }, h('select', { value: row.mode, onChange: event => change(index, { mode: event.target.value }) }, h('option', { value: 'read-only' }, t('directoryReadOnly')), h('option', { value: 'read-write' }, t('directoryReadWrite')))),
                h(Button, { type: 'button', onClick: () => setRows(old => old.filter((_, i) => i !== index)) }, t('removeDirectory')))),
              h('div', { className: 'lanw-row' }, h(Button, { type: 'button', disabled: rows.length >= 32, onClick: () => setRows(old => [...old, { path: '', mode: 'read-only' }]) }, t('addDirectory')),
                recommendedPath && h(Button, { type: 'button', 'data-directory-recommended': true, disabled: rows.length >= 32 && !rows.some(row => !row.path.trim()), onClick: () => {
                  setRows(previous => { if (previous.some(row => row.path === recommendedPath)) return previous; const next = [...previous], index = next.findIndex(row => !row.path.trim()); if (index < 0) next.push({ path: recommendedPath, mode: 'read-only' }); else next[index] = { path: recommendedPath, mode: 'read-only' }; return next; }); onRecommended?.();
                } }, t('directoryRecommended'))),
              recommendedPath && h('p', { className: 'lanw-help lanw-directory-recommendation' }, `${t('directoryRecommendedNote')} ${recommendedPath} · ${t('directoryRecommendedCreate')}`)));
        }
        function WorkspaceInfo({ runtimeReady, memberUrl, isolation, onCheck, pending }) {
          const [open, setOpen] = React.useState(false), dialog = React.useRef(null), opener = React.useRef(null);
          React.useEffect(() => {
            if (!open) return;
            const node = dialog.current; if (node && !node.open) node.showModal();
            return () => { if (node?.open) node.close(); Promise.resolve().then(() => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }); };
          }, [open]);
          return h(React.Fragment, null,
            h(Button, { className: 'lanw-btn lanw-iconbutton', 'data-workspace-info': true, title: t('workspaceInfo'), 'aria-label': t('workspaceInfo'), 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': 'lanw-workspace-info', onClick: event => { opener.current = event.currentTarget; setOpen(true); } },
              h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 11v6M12 7h.01' }))),
            open && h('dialog', { ref: dialog, id: 'lanw-workspace-info', className: 'lanw-editdialog lanw-info-dialog', 'data-workspace-info-dialog': true, 'aria-labelledby': 'lanw-info-title', onKeyDown: containDialogEscape, onCancel: event => { event.preventDefault(); event.stopPropagation?.(); setOpen(false); }, onClick: event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false); } } },
              h('div', { className: 'lanw-info-header' }, h('div', null, h('h2', { id: 'lanw-info-title' }, t('workspaceInfo')), h('p', { className: 'lanw-info-intro' }, t('helpIntro'))), h(Button, { className: 'lanw-iconbutton', 'data-close-info': true, 'aria-label': t('infoClose'), onClick: () => setOpen(false) }, h(IconCloseOutlineRegular, { size: 16 }))),
              h('div', { className: 'lanw-info-content' },
                h('section', null, h('h3', null, h(NavigationLabel, { id: 'sharing' }, t('accessHelp'))), h('p', null, t('accessNote')), memberUrl ? h('a', { className: 'lanw-entry-link', href: memberUrl, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, memberUrl) : h('p', null, t('memberEntryMissing'))),
                h('section', null, h('div', { className: 'lanw-row lanw-spread' }, h('h3', null, h(NavigationLabel, { id: 'security' }, t('runtimeStatus'))), h('span', { className: 'lanw-badge' }, t(runtimeReady === true ? 'isolationPassed' : 'runtimeAutoCheck'))), h('p', null, t('isolationNote')),
                  onCheck && h(Button, { 'data-isolation-check': true, disabled: Boolean(pending), onClick: onCheck }, t(pending === 'admin.checkIsolation' ? 'checkingIsolation' : 'checkIsolation')),
                  isolation?.status === 'ready' && h('p', { role: 'status', 'data-isolation-result': true }, `${t('isolationPassed')} · ${isolation.checks?.length || 0}`),
                  isolation?.status === 'failed' && h('p', { role: 'alert', 'data-isolation-result': true }, `${t('isolationFailed')} · ${isolation.code || 'ISOLATION_UNAVAILABLE'}. ${t(isolation.restartRequired ? 'isolationRestart' : 'isolationRetry')}`)),
                h('section', null, h('h3', null, h(NavigationLabel, { id: 'directories' }, t('userHome'))), h('p', null, t('helpDirectory'))),
                h('section', null, h('h3', null, h(NavigationLabel, { id: 'plugins' }, t('sharingTab'))), h('p', null, t('helpSharing'))))));
        }
        function UserHome({ value }) {
          const status = value?.status === 'ready' ? 'homeReady' : value?.status === 'pending' ? 'homePending' : 'homeUnavailable';
          return h('section', { className: 'lanw-stack', 'data-user-home': true, 'aria-label': t('userHome') },
            h('div', { className: 'lanw-row lanw-spread' }, h('h2', null, t('userHome')), h('span', { className: 'lanw-help', role: 'status' }, t(status))),
            typeof value?.path === 'string' && value.path && h('code', { className: 'lanw-code', 'data-home-alias': true, 'aria-label': t('homeAlias') }, '~'));
        }
        function HomeDirectory({ value, disabled, onSave, onReload }) {
          const [draft, setDraft] = React.useState(value?.configuredRoot ?? value?.root ?? ''), [revision, setRevision] = React.useState(value?.revision);
          const [dirty, setDirty] = React.useState(false), [failed, setFailed] = React.useState(false), [pending, setPending] = React.useState(false);
          React.useEffect(() => { if (!dirty && !failed) { setDraft(value?.configuredRoot ?? value?.root ?? ''); setRevision(value?.revision); } }, [value?.revision, value?.root, value?.configuredRoot, dirty, failed]);
          const validRevision = Number.isSafeInteger(revision) && revision >= 0;
          const conflict = validRevision && revision !== value?.revision, blocked = disabled || pending || failed || conflict || !validRevision;
          async function save(event) {
            event.preventDefault(); if (blocked || !dirty || !draft.trim()) return; setPending(true);
            try { if (await onSave({ root: draft.trim(), expectedRevision: revision }) === true) { setDirty(false); setFailed(false); } else setFailed(true); }
            catch { setFailed(true); } finally { setPending(false); }
          }
          async function reload() {
            if (disabled || pending) return; setPending(true);
            try { const current = await onReload(); if (current && Number.isSafeInteger(current.revision) && current.revision >= 0) { setDraft(current.configuredRoot ?? current.root ?? ''); setRevision(current.revision); setDirty(false); setFailed(false); } }
            catch { setFailed(true); } finally { setPending(false); }
          }
          return h('section', { className: 'lanw-stack', 'data-home-directory': true, 'aria-label': t('homeDirectory') }, h('h2', null, t('homeDirectory')), h('p', { className: 'lanw-help' }, t('homeRootNote')),
            !validRevision && h('p', { role: 'status', className: 'lanw-help' }, t('homeRootUnknown')),
            (failed || conflict) && h('p', { role: 'alert', className: 'lanw-error' }, t('homeRootFailed')),
            h('form', { className: 'lanw-form', onSubmit: save, 'aria-busy': pending }, h('fieldset', { className: 'lanw-fieldset', disabled: blocked },
              h(Field, { label: t('homeRoot') }, h('input', { name: 'root', required: true, maxLength: 2048, placeholder: '/home/<linux-user>/lan-users', autoComplete: 'off', spellCheck: false, value: draft, onChange: event => { setDraft(event.target.value); setDirty(true); } })),
              h(Button, { primary: true, type: 'submit', disabled: blocked || !dirty || !draft.trim() }, t('homeRootSave')))),
            h(Button, { disabled: disabled || pending, onClick: reload }, t('homeRootReload')));
        }
        function BrandingEditor({ value = branding, disabled, onSave, onReload }) {
          const [draft, setDraft] = React.useState(() => ({ ...value })), [dirty, setDirty] = React.useState(false);
          const [busy, setBusy] = React.useState(false), [uploading, setUploading] = React.useState(false), [problem, setProblem] = React.useState('');
          const reader = React.useRef(null), fileInput = React.useRef(null);
          React.useEffect(() => { if (!dirty) setDraft({ ...value }); }, [value.revision, dirty]);
          function releaseUpload() {
            const current = reader.current; reader.current = null;
            current?.reader?.abort();
            if (current) URL.revokeObjectURL(current.url);
          }
          React.useEffect(() => releaseUpload, []);
          const conflict = draft.revision !== value.revision, blocked = disabled || busy || uploading;
          const change = fields => { setDraft(old => ({ ...old, ...fields })); setDirty(true); setProblem(''); };
          function upload(event) {
            const file = event.target.files?.[0]; if (!file) return;
            releaseUpload();
            if (!['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setProblem('brandFileError'); setUploading(false); event.target.value = ''; return; }
            const next = { url: URL.createObjectURL(file) }; reader.current = next; setUploading(true); setProblem('');
            const failed = () => { if (reader.current === next) { releaseUpload(); setProblem('brandFileError'); setUploading(false); } };
            const probe = new Image(); probe.onerror = failed;
            probe.onload = async () => {
              try {
                if (reader.current !== next) return;
                // Four times the largest display box keeps retina detail while
                // accepting large originals without carrying them in settings.
                const scale = Math.min(1, 480 / probe.naturalWidth, 136 / probe.naturalHeight);
                const canvas = new OffscreenCanvas(Math.max(1, Math.round(probe.naturalWidth * scale)), Math.max(1, Math.round(probe.naturalHeight * scale)));
                let image;
                do {
                  canvas.getContext('2d').drawImage(probe, 0, 0, canvas.width, canvas.height);
                  image = await canvas.convertToBlob({ type: 'image/webp', quality: .92 });
                  if (reader.current !== next) return;
                  if (image.size <= 128 * 1024) break;
                  if (canvas.width === 1 && canvas.height === 1) throw new Error('Logo encoding failed');
                  canvas.width = Math.max(1, Math.floor(canvas.width / 2)); canvas.height = Math.max(1, Math.floor(canvas.height / 2));
                } while (true);
                const data = new FileReader(); next.reader = data;
                data.onerror = failed;
                data.onload = () => { if (reader.current === next) { change({ logo: String(data.result) }); setUploading(false); releaseUpload(); } };
                data.readAsDataURL(image);
              } catch { failed(); }
            };
            probe.src = next.url;
          }
          async function save(event) {
            event.preventDefault(); if (blocked || conflict || !dirty) return; setBusy(true);
            try {
              if (await onSave({ logo: draft.logo?.trim() || null, slogan: draft.slogan?.trim() || null, name: draft.name?.trim() || null, badge: draft.badge == null ? null : draft.badge.trim(), showPreviewBadge: draft.showPreviewBadge !== false, expectedRevision: draft.revision })) setDirty(false);
              else setProblem('brandSaveError');
            } catch { setProblem('brandSaveError'); } finally { setBusy(false); }
          }
          async function reload() {
            if (blocked) return; setBusy(true);
            try { const fresh = await onReload(); if (fresh) { setDraft({ ...fresh }); setDirty(false); setProblem(''); if (fileInput.current) fileInput.current.value = ''; } }
            catch { setProblem('brandSaveError'); } finally { setBusy(false); }
          }
          return h(Card, { className: 'lanw-stack lanw-branding', 'data-branding-editor': true },
            h('p', { className: 'lanw-help' }, t('brandingNote')),
            h('div', { className: 'lanw-brand-preview', 'data-brand-preview': true },
              h('div', { className: 'lanw-brand-preview-pane' }, h('span', { className: 'lanw-help' }, t('brandSidebarPreview')), h('div', { className: 'lanw-brand-sidebar-preview' }, h(BrandLogo, { logo: draft.logo, size: 24, maxWidth: 24 }), h(BrandName, { name: draft.name?.trim(), badge: draft.badge?.trim() }))),
              h('div', { className: 'lanw-brand-preview-pane' }, h('span', { className: 'lanw-help' }, t('brandPreview')), h('div', { className: 'lanw-brand-headline' }, h(BrandLogo, { logo: draft.logo, size: 28, maxWidth: 56, onError: () => setProblem('brandImageError') }), h('span', null, draft.slogan?.trim() || nativeText('hero.headline')), draft.showPreviewBadge !== false && h('span', { className: 'lanw-brand-preview-badge', 'data-brand-preview-badge': true }, nativeText('hero.preview'))))),
            h('form', { className: 'lanw-form', onSubmit: save, 'data-branding-form': true, 'aria-busy': blocked }, h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: blocked },
              h('div', { className: 'lanw-brand-field-group' }, h('div', { className: 'lanw-brand-logo-fields' },
                h(Field, { label: t('brandLogo') }, h('input', { ref: fileInput, type: 'file', accept: 'image/svg+xml,image/png,image/jpeg,image/webp', onChange: upload, 'data-brand-logo-upload': true })),
                h(Field, { label: t('brandLogoUrl') }, h('input', { type: 'url', name: 'brandLogo', maxLength: 2048, placeholder: draft.logo?.startsWith('data:') ? t('brandUploaded') : 'https://example.com/logo.png', value: draft.logo?.startsWith('data:') ? '' : draft.logo ?? '', onChange: event => change({ logo: event.target.value || null }) }))),
                h('p', { className: 'lanw-help' }, t('brandLogoNote'))),
              h('div', { className: 'lanw-brand-field-group' }, h('div', { className: 'lanw-brand-name-fields' },
                h(Field, { label: t('brandName') }, h('input', { name: 'brandName', maxLength: 40, placeholder: 'deepseek', value: draft.name ?? 'deepseek', onChange: event => change({ name: event.target.value }) })),
                h(Field, { label: t('brandBadge') }, h('input', { name: 'brandBadge', maxLength: 16, placeholder: 'HARNESS', value: draft.badge ?? 'HARNESS', onChange: event => change({ badge: event.target.value }) }))),
                h('p', { className: 'lanw-help' }, t('brandNameNote'))),
              h('div', { className: 'lanw-brand-field-group' }, h(Field, { label: t('brandSlogan') }, h('input', { name: 'brandSlogan', maxLength: 80, placeholder: nativeText('hero.headline'), value: draft.slogan ?? '', onChange: event => change({ slogan: event.target.value || null }) })),
                h('p', { className: 'lanw-help' }, t('brandSloganNote'))),
              h('div', { className: 'lanw-brand-field-group' }, h(Check, { label: t('brandShowPreviewBadge'), name: 'showPreviewBadge', checked: draft.showPreviewBadge !== false, onChange: event => change({ showPreviewBadge: event.target.checked }) }),
                h('p', { className: 'lanw-help' }, t('brandPreviewBadgeNote'))),
              conflict && h('p', { className: 'lanw-notice', role: 'alert' }, t('brandConflict')),
              problem && h('p', { className: 'lanw-help lanw-error', role: 'alert' }, t(problem)),
              h('div', { className: 'lanw-brand-actions' }, h('div', { className: 'lanw-row' }, h(Button, { disabled: blocked, className: 'lanw-btn-secondary', onClick: () => { change({ logo: null, slogan: null, name: null, badge: null, showPreviewBadge: true }); if (fileInput.current) fileInput.current.value = ''; } }, t('brandReset')), h(Button, { disabled: blocked, onClick: reload }, t('brandReload'))), h(Button, { primary: true, type: 'submit', disabled: blocked || conflict || !dirty }, t('brandSave'))))));
        }
        let nativePreview = null, pendingPreviewReturn = null, previewReturnGeneration = 0, previewRevision = 0;
        const previewListeners = new Set();
        const publishPreview = () => { previewRevision++; for (const listener of previewListeners) listener(); };
        function previewFileAddress(address, sessionId, directory) {
          const prefix = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/`;
          if (!address.startsWith(prefix)) return address;
          const path = address.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
          if (path.startsWith('/') || /^[a-z]:[/\\]/i.test(path)) return address;
          return prefix + `${directory}/${path}`.split('/').map(encodeURIComponent).join('/');
        }
        function mountPreviewFileTree(value) {
          if (!value.fileDirectory) return;
          const name = 'sidebar.right.pane.tab', key = '@deepseek-ai/dsh-client-ui-sidebar-files';
          const native = ctx.slots.entries(name).find(entry => entry.options.key === key);
          if (!native?.component || !native.store?.create) throw failure('ADMIN_PREVIEW_UNAVAILABLE', t('contentFailed'));
          const actionsSlot = 'sidebar.right.tab.files.actions', previewActions = 'multi-user.preview.files.actions';
          // The native tree owns its loading, watching, row UI and commands.
          // Give this presentation its own store; the underlying Session and
          // the reader's original file tree retain their original directories.
          const store = { create: (...args) => native.store.create(...args) };
          const lifetime = new AbortController();
          function PreviewFileTree(props) {
            const useSessions = React.useCallback(selector => props.useSessions(state => {
              if (props.sessionId !== value.sessionId) return selector(state);
              return selector({ ...state, byId: { ...state.byId, [value.sessionId]: { ...state.byId[value.sessionId], cwd: value.fileDirectory } } });
            }), [props.useSessions, props.sessionId]);
            const useTabInfo = React.useCallback(() => {
              const info = props.useTabInfo();
              const signal = React.useMemo(() => AbortSignal.any([info.tab.signal, lifetime.signal]), [info.tab.signal]);
              const actions = React.useMemo(() => ({ ...info.tab.actions,
                openResource: (address, ...args) => {
                  const sidebar = ctx.get('sidebarRight'), before = new Set(sidebar?.tabsIn?.(value.sessionId).map(tab => tab.id) ?? []);
                  const result = info.tab.actions.openResource(props.sessionId === value.sessionId ? previewFileAddress(address, value.sessionId, value.fileDirectory) : address, ...args);
                  if (props.sessionId === value.sessionId) value.openedTabs = [...new Set([...(value.openedTabs ?? []), ...(sidebar?.tabsIn?.(value.sessionId).filter(tab => !before.has(tab.id)).map(tab => tab.id) ?? [])])];
                  return result;
                },
              }), [info.tab.actions, props.sessionId]);
              if (props.sessionId !== value.sessionId) return info;
              return { ...info, tab: { ...info.tab, actions, signal } };
            }, [props.useTabInfo, props.sessionId]);
            return h(native.component, { ...props, useSessions, useTabInfo,
              renderSlot: (name, ...args) => props.renderSlot(name === actionsSlot ? previewActions : name, ...args),
            });
          }
          const releases = [];
          const release = () => { lifetime.abort(); releases.splice(0).reverse().forEach(dispose => dispose()); };
          try {
            releases.push(ctx.slots.register({ name, key, priority: -100, id: 'multi-user-preview-files', store, inject: native.inject, children: { [previewActions]: native.children[actionsSlot] }, locale: native.locale }, PreviewFileTree));
            for (const entry of ctx.slots.entries(actionsSlot)) releases.push(ctx.slots.register({ ...entry.options, name: previewActions, inject: entry.inject, store: entry.store, locale: entry.locale }, entry.component));
          } catch (error) { release(); throw error; }
          return release;
        }
        function releaseNativePreview({ refresh = true } = {}) {
          const current = nativePreview; if (!current) return;
          nativePreview = null; current.unwatch?.(); current.reference?.release();
          window.__DSH_LAN_ADMIN_PREVIEW__ = false;
          const blocks = ctx.get('conversation')?.blocks;
          if (blocks?.storeFor(current.sessionId).getSnapshot() === current.block) blocks.set(current.sessionId, current.previousBlock);
          const sidebar = ctx.get('sidebarRight');
          for (const id of current.openedTabs ?? []) sidebar?.closeIn(current.sessionId, id);
          current.releaseFileTree?.();
          const released = current.release().catch(() => {});
          publishPreview();
          return refresh ? released.then(() => ctx.get('sessions')?.refresh()).catch(() => {}) : released;
        }
        let openWorkspaceWindow, startupStatus;
        async function returnFromNativePreview(value) {
          if (nativePreview !== value) return;
          const generation = ++previewReturnGeneration;
          // Revoke in parallel with returning to the original conversation.
          // Refreshing the session list while the foreign preview is selected
          // can trigger another navigation; do it after the original shell is back.
          const released = releaseNativePreview({ refresh: false });
          const sidebar = ctx.get('sidebarRight'), previous = value.previousSession;
          if (previous && sidebar.mounted.getSnapshot() !== previous) {
            await new Promise(resolve => {
              let timeout, unsubscribe;
              const done = () => { clearTimeout(timeout); unsubscribe?.(); resolve(); };
              unsubscribe = sidebar.mounted.subscribe(() => { if (sidebar.mounted.getSnapshot() === previous) done(); });
              timeout = setTimeout(done, 1500);
              try { Promise.resolve(ctx.get('uiWorkspace').openSession(previous)).catch(done); }
              catch (_) { done(); }
            });
          }
          // The mounted store changes before React commits the native shell.
          // Do not open a modal on the page that is being torn down.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (generation !== previewReturnGeneration) return;
          pendingPreviewReturn = value.returnPoint;
          openWorkspaceWindow?.();
          void released.then(() => ctx.get('sessions')?.refresh()).catch(() => {});
        }
        async function openNativePreview(value, release, closeSettings, returnPoint) {
          previewReturnGeneration++;
          const returnSession = nativePreview?.previousSession;
          releaseNativePreview();
          const sessions = ctx.get('sessions'), navigation = ctx.get('uiWorkspace'), sidebar = ctx.get('sidebarRight'), blocks = ctx.get('conversation')?.blocks;
          if (!sessions || !navigation || !sidebar || !blocks || !closeSettings || !openWorkspaceWindow) { await release(); throw failure('ADMIN_PREVIEW_UNAVAILABLE', t('contentFailed')); }
          const current = { ...value, release, returnPoint, previousSession: returnSession ?? sidebar.mounted.getSnapshot(), previousBlock: blocks.storeFor(value.sessionId).getSnapshot(), entered: false };
          nativePreview = current;
          window.__DSH_LAN_ADMIN_PREVIEW__ = true;
          try {
            current.releaseFileTree = mountPreviewFileTree(current);
            blocks.set(value.sessionId, { reason: t(value.self ? 'personalPreviewReadOnly' : 'contentPreviewReadOnly') }); current.block = blocks.storeFor(value.sessionId).getSnapshot();
            if (!sessions.list?.getSnapshot().byId[value.sessionId]) await sessions.refresh();
            if (sessions.list && !sessions.list.getSnapshot().byId[value.sessionId]) {
              await new Promise(resolve => setTimeout(resolve, 0));
              await sessions.refresh();
              if (!sessions.list.getSnapshot().byId[value.sessionId]) throw failure('ADMIN_PREVIEW_UNAVAILABLE', t('contentFailed'));
            }
            if (nativePreview !== current) return;
            current.reference = sessions.retain(value.sessionId, { source: 'controllerOperation' });
            const readiness = current.reference.ready;
            const releaseReadyReference = () => { if (current.entered && current.ready) { current.reference?.release(); current.reference = null; } };
            const mounted = () => {
              if (nativePreview !== current) return;
              if (sidebar.mounted.getSnapshot() === value.sessionId) {
                if (current.entered) return; current.entered = true;
                requestAnimationFrame(() => {
                  if (nativePreview !== current) return;
                  releaseReadyReference();
                  if (value.fileAddress) {
                    const before = new Set(sidebar.tabsIn(value.sessionId).map(tab => tab.id));
                    sidebar.openResource(value.fileAddress);
                    current.openedTabs = sidebar.tabsIn(value.sessionId).filter(tab => !before.has(tab.id)).map(tab => tab.id);
                  }
                });
              } else if (current.entered) releaseNativePreview();
            };
            current.unwatch = sidebar.mounted.subscribe(mounted);
            publishPreview(); navigation.openSession(value.sessionId); current.navigated = true; closeSettings(); mounted();
            await readiness;
            if (nativePreview !== current) return;
            current.ready = true; releaseReadyReference(); publishPreview();
          } catch (error) {
            if (nativePreview !== current) return;
            if (current.navigated) { current.error = true; publishPreview(); return; }
            releaseNativePreview(); throw error;
          }
        }
        function NativePreviewNotice({ sessionId }) {
          useLocale();
          React.useSyncExternalStore(callback => { previewListeners.add(callback); return () => previewListeners.delete(callback); }, () => previewRevision);
          const value = nativePreview;
          if (value?.sessionId !== sessionId) return null;
          return h('div', { 'data-admin-native-preview': true, role: 'status', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('div', null, h('strong', { style: { display: 'block', marginBottom: 4, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, `${t(value.self ? 'personalPreview' : 'contentPreview')} · ${value.displayName}`), h('span', { role: value.error ? 'alert' : undefined }, t(value.error ? 'contentPreviewLoadFailed' : !value.ready ? 'contentPreviewLoading' : value.self ? 'personalPreviewReadOnly' : 'contentPreviewReadOnly'))),
            h('button', { type: 'button', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '5px 8px', font: 'inherit', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }, onClick: () => returnFromNativePreview(value) }, t('contentEndPreview')));
        }
        ctx.effect(() => () => { previewReturnGeneration++; releaseNativePreview(); pendingPreviewReturn = null; previewListeners.clear(); });
        ctx.slots.inject('conversation.composer', () => {
          let unregister, sessionId;
          const reconcile = () => {
            const next = nativePreview?.sessionId;
            if (next === sessionId) return;
            unregister?.(); unregister = undefined; sessionId = next;
            if (next) unregister = ctx.slots.register({ name: 'conversation.composer', id: 'lan-administrator-preview', priority: -20, select: owner => owner.sessionId === next ? {} : null }, NativePreviewNotice);
          };
          previewListeners.add(reconcile); reconcile();
          return () => { previewListeners.delete(reconcile); unregister?.(); };
        });

        function RecycleBin({ user, request, onClose, contentEndpoint = 'admin.content' }) {
          const [result, setResult] = React.useState({ items: [], total: 0 }), [offset, setOffset] = React.useState(0), [pending, setPending] = React.useState(false), [error, setError] = React.useState(''), [purge, setPurge] = React.useState(null);
          const alive = React.useRef(true), working = React.useRef(false);
          const api = (operation, fields = {}) => request(contentEndpoint, { operation, userId: user.id, ...fields });
          async function load() {
            try { const value = await api('trash.list', { offset, limit: 25 }); if (alive.current) { setResult(value); if (offset && offset >= value.total) setOffset(0); } }
            catch (err) { if (alive.current) setError(err.message || t('contentFailed')); }
          }
          React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [user.id, offset]);
          async function act(operation, item) {
            if (working.current) return;
            working.current = true; setPending(true); setError('');
            try { await api(operation, { recycleId: item.id, ...(operation === 'trash.purge' ? { confirm: true } : {}) }); if (alive.current) { setPurge(null); await load(); } }
            catch (err) { if (alive.current) setError(err.code === 'ADMIN_FILE_EXISTS' ? t('contentExists') : err.message || t('contentFailed')); }
            finally { working.current = false; if (alive.current) setPending(false); }
          }
          return h(EditDialog, { title: t('recycleBin'), subtitle: `${user.displayName} · @${user.username}`, pending, onClose, footer: purge
            ? h('div', { className: 'lanw-row' }, h(Button, { disabled: pending, onClick: () => setPurge(null) }, t('contentCancel')), h(Button, { disabled: pending, primary: true, onClick: () => act('trash.purge', purge) }, t('recyclePurge')))
            : h('div', { className: 'lanw-row lanw-pagination' }, h('span', { className: 'lanw-help' }, `${t('contentCount')} ${result.total}`), h(Button, { disabled: pending || offset === 0, onClick: () => setOffset(n => Math.max(0, n - 25)) }, t('contentPrev')), h('span', { className: 'lanw-help' }, `${Math.floor(offset / 25) + 1} / ${Math.max(1, Math.ceil(result.total / 25))}`), h(Button, { disabled: pending || offset + 25 >= result.total, onClick: () => setOffset(n => n + 25) }, t('contentNext'))) },
            h('div', { className: 'lanw-stack', 'data-recycle-bin': true }, h('p', { className: 'lanw-help' }, t('recycleNote')), error && h('p', { role: 'alert', className: 'lanw-help lanw-error' }, error),
              purge ? h('div', null, h('h3', null, purge.name), h('p', null, t('recyclePurgeConfirm'))) : result.items.length ? h('div', { className: 'lanw-tablewrap' }, h('table', null,
                h('thead', null, h('tr', null, ['contentName', 'recycleOriginal', 'recycleDeletedAt', 'contentActions'].map(key => h('th', { key }, t(key))))),
                h('tbody', null, result.items.map(item => h('tr', { key: item.id, 'data-recycle-item': item.id }, h('td', null, item.name), h('td', { style: { overflowWrap: 'anywhere' } }, item.path), h('td', null, new Date(item.deletedAt).toLocaleString()), h('td', null, h('div', { className: 'lanw-row' }, h(Button, { disabled: pending, onClick: () => act('trash.restore', item) }, t('recycleRestore')), h(Button, { disabled: pending, onClick: () => setPurge(item) }, t('recyclePurge'))))))))) : h('p', { className: 'lanw-empty' }, t('recycleEmpty'))));
        }

        const sessionDefaults = Object.freeze({ content: 'messages', status: 'all', archive: 'active', searchScope: 'all', sort: 'updated-desc', from: '', to: '' });
        const fileDefaults = Object.freeze({ kind: 'all', extensions: '', emptyFolders: 'exclude', sort: 'name-asc', from: '', to: '' });
        const filterCount = (value, defaults) => Object.keys(defaults).filter(key => value[key] !== defaults[key] && (key !== 'emptyFolders' || ['all', 'directory'].includes(value.kind))).length;
        function filterDates(value) {
          const result = {};
          if (value.from) result.updatedFrom = new Date(`${value.from}T00:00:00`).getTime();
          if (value.to) { const end = new Date(`${value.to}T00:00:00`); end.setDate(end.getDate() + 1); result.updatedBefore = end.getTime(); }
          return result;
        }
        function ContentFilters({ mode, value, onApply, onClose }) {
          const [draft, setDraft] = React.useState(value);
          const files = mode === 'files', defaults = files ? fileDefaults : sessionDefaults;
          const select = (key, label, options, disabled = false) => h(Field, { label: t(label) }, h('select', { value: draft[key], disabled, 'data-filter-field': key, onChange: event => setDraft(old => ({ ...old, [key]: event.target.value, ...(key === 'kind' && !['all', 'file'].includes(event.target.value) ? { extensions: '' } : {}), ...(key === 'kind' && !['all', 'directory'].includes(event.target.value) ? { emptyFolders: 'all' } : {}), ...(key === 'emptyFolders' && event.target.value === 'only' ? { kind: 'directory', extensions: '' } : {}) })) }, options.map(([value, label]) => h('option', { key: value, value }, t(label)))));
          return h(EditDialog, { title: t('advancedFilters'), subtitle: t(files ? 'fileFilterNote' : 'filterNote'), className: 'lanw-filter-dialog', confirmChanges: false, onClose, footer: h(React.Fragment, null,
            h(Button, { onClick: () => setDraft(defaults), 'data-filter-defaults': true }, t('filterReset')),
            h(Button, { primary: true, type: 'submit', form: 'lanw-filter-form' }, t('filterApply'))) },
            h('form', { id: 'lanw-filter-form', className: 'lanw-form', 'data-content-filter-form': mode, onSubmit: event => { event.preventDefault(); onApply(files ? { ...draft, extensions: draft.extensions.trim() } : draft); onClose(); } },
              h('div', { className: 'lanw-filter-grid' },
                files ? select('kind', 'filterKind', [['all', 'filterAny'], ['file', 'contentFile'], ['directory', 'contentFolder'], ['link', 'contentLink']]) : select('content', 'filterContent', [['messages', 'filterMessages'], ['all', 'filterAllContent'], ['empty', 'filterEmpty']]),
                !files && select('status', 'filterStatus', [['all', 'filterAny'], ['running', 'contentRunning'], ['idle', 'contentIdle']]),
                !files && select('archive', 'filterArchive', [['active', 'filterActive'], ['archived', 'filterArchived'], ['all', 'filterAny']]),
                !files && select('searchScope', 'filterScope', [['all', 'filterScopeAll'], ['title', 'filterScopeTitle'], ['member', 'filterScopeMember'], ['id', 'filterScopeId']]),
                h('div', { className: files ? undefined : 'lanw-filter-wide' }, select('sort', 'filterSort', files ? [['name-asc', 'filterName'], ['name-desc', 'filterNameDesc'], ['updated-desc', 'filterNewest'], ['updated-asc', 'filterOldest'], ['size-desc', 'filterLargest']] : [['updated-desc', 'filterNewest'], ['updated-asc', 'filterOldest'], ['title', 'filterName']])),
                files && h('div', { className: 'lanw-filter-wide' }, select('emptyFolders', 'filterEmptyFolders', [['all', 'filterFoldersAll'], ['exclude', 'filterFoldersHide'], ['only', 'filterFoldersOnly']], !['all', 'directory'].includes(draft.kind)), h('p', { className: 'lanw-help' }, t('filterFoldersNote'))),
                files && h('div', { className: 'lanw-filter-wide' }, h(Field, { label: t('filterExtensions') }, h('input', { value: draft.extensions, maxLength: 100, disabled: !['all', 'file'].includes(draft.kind), placeholder: t('filterExtensionsHint'), 'data-filter-field': 'extensions', onChange: event => setDraft(old => ({ ...old, extensions: event.target.value })) })), h('p', { className: 'lanw-help' }, t('filterExtensionsNote'))),
                h(Field, { label: t('filterFrom') }, h('input', { type: 'date', value: draft.from, max: draft.to || undefined, 'data-filter-field': 'from', onChange: event => setDraft(old => ({ ...old, from: event.target.value })) })),
                h(Field, { label: t('filterTo') }, h('input', { type: 'date', value: draft.to, min: draft.from || undefined, 'data-filter-field': 'to', onChange: event => setDraft(old => ({ ...old, to: event.target.value })) }))),
              h('p', { className: 'lanw-help' }, t('filterDateNote'))));
        }
        function AccountActions({ account, currentUserId, disabled, onEdit, onOperation, enabled }) {
          const [open, setOpen] = React.useState(false), opener = React.useRef(null);
          const archived = account.archivedAt != null;
          const items = archived
            ? [{ id: 'restore', label: t('restoreAccount'), disabled }, { id: 'delete', label: t('deleteAccount'), danger: true, disabled }]
            : [{ id: 'edit', label: t('editAccount'), disabled }, ...(enabled ? [{ id: 'archive', label: t('archiveAccount'), disabled: disabled || account.id === currentUserId }] : [])];
          return h('span', { className: 'lanw-account-menu-host', onKeyDownCapture: event => {
            if (!open || !isDismissKey(event)) return;
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) { setOpen(false); Promise.resolve().then(() => opener.current?.focus?.({ preventScroll: true })); }
          } }, h(Menu, { open, onClose: () => setOpen(false), items, portal: true, align: 'end', autoFocus: true, className: 'lanw-content-menu', onSelect: id => {
            if (!items.some(item => item.id === id && !item.disabled)) return;
            setOpen(false); if (id === 'edit') onEdit(); else onOperation(id);
          }, anchor: h(Button, { disabled, 'data-account-manage': account.id, 'aria-label': `${t('contentManage')} ${account.displayName || account.username}`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: event => { opener.current = event?.currentTarget ?? null; setOpen(value => !value); } }, t('contentManage')) }));
        }
        function AccountOperationDialog({ operation, pending, error, onConfirm, onClose }) {
          const [confirmation, setConfirmation] = React.useState('');
          const { kind, account } = operation, deleting = kind === 'delete', title = t(`${kind}Account`);
          return h(EditDialog, { title, subtitle: `${account.displayName} · @${account.username}`, className: 'lanw-account-operation-dialog', editorKind: kind, pending, onClose, confirmChanges: false,
            footer: h(Button, { type: 'submit', form: 'lanw-account-operation-form', primary: !deleting, className: deleting ? 'lanw-delete-account' : '', disabled: pending || deleting && confirmation !== account.username }, t(pending ? 'pending' : `${kind}Account`)) },
            h('form', { id: 'lanw-account-operation-form', className: 'lanw-form lanw-stack', 'data-account-operation': kind, 'aria-busy': pending, onSubmit: event => { event.preventDefault(); if (!pending && (!deleting || confirmation === account.username)) void onConfirm(confirmation); } },
              h('p', { className: 'lanw-help' }, t(`${kind}AccountNote`)),
              deleting && h(Field, { label: t('confirmAccountUsername') }, h('input', { name: 'confirmUsername', value: confirmation, required: true, autoComplete: 'off', spellCheck: false, placeholder: account.username, 'data-modal-autofocus': true, disabled: pending, onChange: event => setConfirmation(event.target.value) })),
              error && h('p', { role: 'alert', className: 'lanw-notice lanw-error' }, error.code === 'ACCOUNT_CONFLICT' ? t('accountOperationConflict') : error.message || t('requestFailed'))));
        }
        function fileMenuItems(item, pending = false, readOnly = false) {
          const option = (id, label, disabled = false) => ({ id, label: t(label), disabled: pending || disabled, danger: id === 'delete' });
          const entries = item.kind === 'directory' ? [option('open', 'contentOpenFolder')] : item.kind === 'file' ? [option('view', 'contentFileView')] : [];
          if (readOnly) return entries;
          return [...entries, ...(item.kind === 'file' ? [option('edit', 'contentEditText'), option('download', 'contentDownload'), option('replace', 'contentReplace')] : []),
            { id: 'separator', type: 'separator' }, ...(item.bound ? [{ id: 'bound', type: 'label', text: t('contentBoundMenu') }] : []),
            option('rename', 'contentRename', item.bound), option('move', 'contentMove', item.bound), option('delete', 'contentDelete', item.bound)];
        }
        function SidebarFileMenu({ sessionId, launch }) {
          useLocale();
          const mount = React.useRef(null), [menu, setMenu] = React.useState(null);
          React.useEffect(() => {
            const tree = mount.current?.closest('[data-files-root]');
            if (!tree) return;
            function open(event) {
              if (event.type === 'keydown' && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              const entry = event.target?.closest?.('[data-files-entry]'), button = entry?.querySelector(':scope > button');
              const kind = entry?.getAttribute('data-files-entry'), path = entry?.getAttribute('data-files-path');
              if (!tree.contains(entry) || !button || !path || !['file', 'directory'].includes(kind)) return;
              event.preventDefault(); event.stopPropagation();
              const rect = button.getBoundingClientRect(), keyboard = event.type === 'keydown';
              const preview = nativePreview?.sessionId === sessionId ? nativePreview : null;
              const administrator = Boolean(preview?.userId && preview.self !== true);
              const readOnly = !administrator && (window.__DSH_LAN_ADMIN_PREVIEW__ === true || Boolean(ctx.get('conversation')?.blocks?.storeFor(sessionId)?.getSnapshot()));
              button.focus({ preventScroll: true });
              setMenu({ item: { kind, path, name: path.split('/').at(-1) }, opener: button, tree, readOnly, administrator, preview: administrator ? preview : null, userId: administrator ? preview.userId : undefined, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY });
            }
            tree.addEventListener('contextmenu', open); tree.addEventListener('keydown', open);
            return () => { tree.removeEventListener('contextmenu', open); tree.removeEventListener('keydown', open); };
          }, [sessionId]);
          const close = () => { const opener = menu?.opener; setMenu(null); Promise.resolve().then(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); }); };
          const items = menu ? fileMenuItems(menu.item, false, menu.readOnly) : [];
          return h('span', { ref: mount, className: 'lanw-sidebar-file-menu', 'data-sidebar-file-menu': sessionId, onKeyDownCapture: event => { if (menu && isDismissKey(event)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) close(); } } }, menu && h('span', { style: { position: 'fixed', left: menu.x, top: menu.y, width: 1, height: 1 } }, h(Menu, {
            open: true, portal: true, autoFocus: true, align: 'start', className: 'lanw-content-menu', items, onClose: close,
            anchor: h('span', { style: { display: 'block', width: 1, height: 1 } }),
            onSelect: action => {
              if (!items.some(item => item.id === action && !item.disabled && !item.type)) return;
              setMenu(null);
              if (action === 'view' || action === 'open') { menu.opener.click(); return; }
              launch({ action, sessionId, userId: menu.userId, administrator: menu.administrator, path: menu.item.path, opener: menu.opener, refresh: () => {
                menu.tree.querySelector('[data-files-reload]')?.click();
                if (menu.preview !== nativePreview || !menu.preview?.fileAddress || !['rename', 'move', 'delete'].includes(action)) return;
                const prefix = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/`;
                const path = menu.preview.fileAddress.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
                if (path === menu.item.path || path.startsWith(menu.item.path + '/')) void returnFromNativePreview(menu.preview);
              } });
            },
          })));
        }
        function SidebarFileOperation({ command, request, close }) {
          const [value, setValue] = React.useState(null), [error, setError] = React.useState('');
          React.useEffect(() => {
            let alive = true;
            request(command.administrator ? 'admin.content' : 'member.content', { operation: 'files.resolve', ...(command.administrator ? { userId: command.userId } : {}), sessionId: command.sessionId, path: command.path }).then(result => {
              if (alive) setValue({ ...result, command: { ...command, item: result.item } });
            }).catch(error => { if (alive) setError(error.message || t('contentFailed')); });
            return () => { alive = false; };
          }, [command, request]);
          return value ? h(ContentManager, { users: [value.user], own: !command.administrator, request, active: false, sidebarCommand: value.command, onSidebarClose: close,
            returnPoint: { mode: 'files', userId: value.user.id, path: value.item.path.split('/').slice(0, -1).join('/') } }) : h(EditDialog, { title: t('contentManage'), subtitle: command.path.split('/').at(-1), pending: !error, confirmChanges: false, className: 'lanw-content-action-dialog', returnFocusTo: command.opener, onClose: close }, h('p', { role: error ? 'alert' : 'status' }, error || t('loading')));
        }
        function ContentActions({ item, mode, pending, onAction, fileAccess = true }) {
          const [open, setOpen] = React.useState(false);
          const opener = React.useRef(null);
          const option = (id, label, disabled = false) => ({ id, label: t(label), disabled: pending || disabled, danger: id === 'delete' });
          const items = mode === 'sessions' ? [
            option('view', 'contentView'), option('sessionRename', 'contentRename'), option('stop', 'contentStop', !item.running),
            option(item.archived ? 'restore' : 'archive', item.archived ? 'contentRestore' : 'contentArchive'), option('files', 'contentOpenFiles', item.filePath === null || !fileAccess),
          ] : fileMenuItems(item, pending);
          return h('span', { className: 'lanw-content-menu-host', onKeyDownCapture: event => {
            if (!open || !isDismissKey(event)) return;
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) { setOpen(false); Promise.resolve().then(() => opener.current?.focus?.({ preventScroll: true })); }
          } }, h(Menu, { open, onClose: () => setOpen(false), items, portal: true, align: 'end', autoFocus: true, className: 'lanw-content-menu', onSelect: id => {
            if (!items.some(item => item.id === id && !item.type && !item.disabled)) return;
            setOpen(false); onAction(id, item, opener.current);
          }, anchor: h(Button, { disabled: pending, 'data-content-manage': item.sessionId ?? item.path, 'aria-label': `${t('contentManage')} ${item.title ?? item.name}`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: event => { opener.current = event?.currentTarget ?? null; setOpen(value => !value); } }, t('contentManage')) }));
        }
        function ContentManager({ users, userPage, request, active, closeSettings, capturePreviewRelease, administratorId, returnPoint, own = false, fileAccess = true, historicalAccounts = false, sidebarCommand, onSidebarClose, pageMode, onModeChange }) {
          const contentEndpoint = own ? 'member.content' : 'admin.content';
          const [recycleOpen, setRecycleOpen] = React.useState(false);
          const [localMode, setLocalMode] = React.useState(returnPoint?.mode ?? 'sessions'), [userId, setUserId] = React.useState(returnPoint?.userId ?? '');
          const mode = pageMode ?? localMode, setMode = onModeChange ?? setLocalMode;
          const [path, setPath] = React.useState(returnPoint?.path ?? ''), [query, setQuery] = React.useState(returnPoint?.query ?? ''), [offset, setOffset] = React.useState(returnPoint?.offset ?? 0);
          const [sessionFilters, setSessionFilters] = React.useState(returnPoint?.sessionFilters ?? sessionDefaults), [fileFilters, setFileFilters] = React.useState(returnPoint?.fileFilters ?? fileDefaults), [fileQuery, setFileQuery] = React.useState(returnPoint?.fileQuery ?? ''), [filtersOpen, setFiltersOpen] = React.useState(false);
          const [result, setResult] = React.useState(() => returnPoint?.listing ?? { items: [], total: 0 }), [loading, setLoading] = React.useState(false), [pending, setPending] = React.useState(false);
          const [error, setProblem] = React.useState(''), [notice, setMessage] = React.useState(''), [dialog, setDialog] = React.useState(null), [name, setName] = React.useState(''), [text, setText] = React.useState('');
          const [progress, setProgress] = React.useState(null), [download, setDownload] = React.useState(null);
          const alive = React.useRef(true), sequence = React.useRef(0), working = React.useRef(false), cancel = React.useRef(false), uploadInput = React.useRef(null), uploadTarget = React.useRef(null), downloadLink = React.useRef(null);
          const root = React.useRef(null), restorePosition = React.useRef(returnPoint);
          const previousMode = React.useRef(mode);
          React.useEffect(() => {
            if (previousMode.current === mode) return;
            previousMode.current = mode; setOffset(0); setProblem(''); setMessage(''); setFiltersOpen(false);
          }, [mode]);
          const selected = own ? users[0]?.id : mode === 'files' ? userId || users[0]?.id : userId;
          const [chosenUser, setChosenUser] = React.useState(() => returnPoint?.selectedUser ?? null);
          const selectedUser = users.find(user => user.id === selected) || (chosenUser?.id === selected ? chosenUser : null);
          React.useEffect(() => {
            if (own || !active || !selected || selectedUser) return;
            let current = true;
            request('admin.getUser', { userId: selected }).then(value => { if (current && value.user?.id === selected) setChosenUser(value.user); }).catch(() => {});
            return () => { current = false; };
          }, [own, active, selected, selectedUser, request]);
          const contextKey = JSON.stringify([mode, selected ?? '', path, offset, mode === 'sessions' ? [query, sessionFilters] : [fileQuery, fileFilters]]);
          const view = result.contextKey === contextKey ? result : { items: [], total: 0 };
          const pageSize = mode === 'sessions' ? 10 : 25;
          const api = (operation, fields = {}) => request(contentEndpoint, { operation, userId: selected || undefined, ...fields });
          const joinPath = (base, leaf) => base ? `${base}/${leaf}` : leaf;
          const parentPath = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
          const openDirectory = value => { setPath(value); setOffset(0); setFileQuery(''); setFileFilters(fileDefaults); setMessage(''); };
          const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
          const number = value => Number(value).toLocaleString();
          const problem = err => { const key = { ADMIN_DIRECTORY_BOUND: 'contentBound', ADMIN_FILE_CONFLICT: 'contentConflict', ADMIN_FILE_EXISTS: 'contentExists', ADMIN_FILE_DENIED: 'contentLinkDenied' }[err.code]; return key ? t(key) : err.message || t('contentFailed'); };
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; cancel.current = true; sequence.current++; }; }, []);
          React.useEffect(() => { if (own && !fileAccess && mode === 'files') { setMode('sessions'); setPath(''); setOffset(0); } }, [own, fileAccess, mode]);
          React.useEffect(() => {
            if (!download) return;
            downloadLink.current?.click?.();
            const closeTimer = sidebarCommand ? setTimeout(() => onSidebarClose?.(), 0) : null;
            return () => { if (closeTimer !== null) clearTimeout(closeTimer); URL.revokeObjectURL(download.url); };
          }, [download]);
          const load = React.useCallback(async () => {
            if (sidebarCommand) { try { await sidebarCommand.refresh?.(); } finally { onSidebarClose?.(); } return; }
            const generation = ++sequence.current; setLoading(true); setProblem('');
            try {
              const { from, to, ...conditions } = mode === 'sessions' ? sessionFilters : fileFilters;
              const value = await request(contentEndpoint, { operation: mode === 'sessions' ? 'sessions.list' : 'files.list', userId: selected || undefined, ...conditions, ...filterDates({ from, to }), search: (mode === 'sessions' ? query : fileQuery).trim(), ...(mode === 'files' ? { path } : {}), offset, limit: pageSize });
              if (alive.current && generation === sequence.current) { setResult({ ...value, contextKey }); if (offset > 0 && offset >= value.total) setOffset(0); }
            } catch (err) { if (alive.current && generation === sequence.current) { setProblem(problem(err)); setResult({ items: [], total: 0, contextKey }); } }
            finally { if (alive.current && generation === sequence.current) setLoading(false); }
          }, [request, mode, selected, path, offset, query, sessionFilters, fileQuery, fileFilters]);
          React.useEffect(() => { if (!active) return; const timer = setTimeout(() => { void load(); }, 150); return () => { clearTimeout(timer); sequence.current++; }; }, [active, load]);
          React.useEffect(() => {
            const saved = restorePosition.current;
            if (!saved || !active || loading || result.contextKey !== contextKey) return;
            // Rows must be back before restoring the outer settings scroller;
            // restoring while loading would clamp its position to the short page.
            const frame = requestAnimationFrame(() => {
              if (!root.current) return;
              const entries = [...root.current.querySelectorAll(saved.focusManage ? '[data-content-manage]' : '[data-content-entry]')];
              const opener = entries.findLast(element => element.getAttribute(saved.focusManage ? 'data-content-manage' : 'data-content-entry') === saved.focusKey);
              opener?.focus({ preventScroll: true });
              for (const position of saved.scroll) {
                let element = root.current;
                for (let depth = 0; depth < position.depth && element; depth++) element = element.parentElement;
                if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
              }
              restorePosition.current = null;
            });
            return () => cancelAnimationFrame(frame);
          }, [active, loading, result, contextKey]);
          async function work(operation) {
            if (working.current) return;
            working.current = true; cancel.current = false; setPending(true); setProblem(''); setMessage('');
            try { await operation(); }
            catch (err) { if (alive.current) setProblem(err.code === 'CONTENT_CANCELLED' ? t('contentCancel') : problem(err)); }
            finally { working.current = false; if (alive.current) { setPending(false); setProgress(null); } }
          }
          function checkTransfer() { if (!alive.current || cancel.current) throw failure('CONTENT_CANCELLED', t('contentCancel')); }
          async function upload(blob, destination, revision = null) {
            const begun = await api('upload.begin', { path: destination, size: blob.size, revision });
            let finished = false;
            try {
              for (let position = 0; position < blob.size; position += begun.chunkBytes) {
                checkTransfer();
                const bytes = new Uint8Array(await blob.slice(position, position + begun.chunkBytes).arrayBuffer());
                const data = btoa(String.fromCharCode(...bytes));
                await api('upload.chunk', { uploadId: begun.uploadId, offset: position, data });
                if (alive.current) setProgress({ done: Math.min(blob.size, position + bytes.length), total: blob.size });
              }
              checkTransfer(); await api('upload.finish', { uploadId: begun.uploadId }); finished = true;
            } finally { if (!finished) await api('upload.abort', { uploadId: begun.uploadId }).catch(() => {}); }
          }
          function downloadFile(item) {
            return work(async () => {
              const parts = []; let position = 0, revision;
              do {
                checkTransfer(); const part = await api('files.download', { path: item.path, offset: position, ...(revision ? { revision } : {}) });
                parts.push(Uint8Array.from(atob(part.data), value => value.charCodeAt(0))); revision = part.revision;
                if (part.nextOffset <= position && position < part.size) throw failure('INVALID_RESPONSE', t('contentFailed'));
                position = part.nextOffset; setProgress({ done: position, total: part.size });
                if (position >= part.size) break;
              } while (true);
              if (alive.current) setDownload({ url: URL.createObjectURL(new Blob(parts)), name: item.name });
            });
          }
          function fileDialog(item, opener) {
            return work(async () => { const value = await api('files.read', { path: item.path }); if (alive.current) { setText(value.text ?? ''); setDialog({ kind: 'file', item, value, opener }); } });
          }
          function historyDialog(item, focusManage = false) {
            return nativeDialog('session.preview', { userId: item.userId, sessionId: item.sessionId }, focusManage);
          }
          function nativeDialog(operation, fields, focusManage = false) {
            const scroll = [];
            for (let element = root.current, depth = 0; element; element = element.parentElement, depth++) {
              if (element.scrollTop || element.scrollLeft) scroll.push({ depth, top: element.scrollTop, left: element.scrollLeft });
            }
            const returnPoint = { administratorId, self: own, mode, userId: selected, selectedUser, listing: view, path, query, sessionFilters, fileFilters, fileQuery, offset, scroll, focusKey: fields.sessionId ?? fields.path, focusManage };
            return work(async () => {
              setMessage(t('contentPreviewLoading'));
              const release = capturePreviewRelease();
              const container = operation === 'files.preview' ? nativePreview?.previousSession ?? ctx.get('sidebarRight')?.mounted.getSnapshot() : null;
              const value = await api(operation, typeof container === 'string' ? { ...fields, sessionId: container } : fields);
              if (own && operation === 'session.preview') { await ctx.get('uiWorkspace').openSession(value.sessionId); closeSettings?.(); return; }
              await openNativePreview(value, () => release(value.previewId), closeSettings, returnPoint);
            });
          }
          function sessionAction(operation, item, fields = {}) {
            return work(async () => { await api(operation, { userId: item.userId, sessionId: item.sessionId, ...fields }); if (alive.current) { setDialog(null); setMessage(t(operation === 'session.cancel' ? 'contentStopRequested' : 'contentDone')); await load(); } });
          }
          function startDialog(kind, item, opener) { setName(kind === 'move' ? parentPath(item.path) : item?.name ?? item?.title ?? ''); setText(''); setDialog({ kind, item, opener }); setProblem(''); }
          function contentAction(action, item, opener) {
            if (action === 'view') return mode === 'sessions' ? historyDialog(item, true) : nativeDialog('files.preview', { path: item.path }, true);
            if (action === 'open') return openDirectory(item.path);
            if (action === 'edit') return fileDialog(item, opener);
            if (action === 'download') return downloadFile(item);
            if (action === 'replace') return chooseUpload(item);
            if (action === 'files') { if (own && !fileAccess) { setProblem(t('ownFilesDisabled')); return; } setUserId(item.userId); openDirectory(item.filePath); setMode('files'); return; }
            if (['stop', 'archive', 'restore'].includes(action)) return sessionAction(action === 'stop' ? 'session.cancel' : `session.${action}`, item);
            startDialog(action, item, opener);
          }
          function chooseUpload(item = null) { uploadTarget.current = item; if (uploadInput.current) { uploadInput.current.multiple = !item; uploadInput.current.value = ''; uploadInput.current.click(); } }
          function selectedUpload(event) {
            const files = Array.from(event.target.files ?? []), target = uploadTarget.current;
            if (!files.length) return;
            return work(async () => {
              for (const file of files) { setProgress({ done: 0, total: file.size }); await upload(file, target ? target.path : joinPath(path, file.name), target?.revision ?? null); }
              if (alive.current) { setDialog(null); setMessage(t('contentDone')); await load(); }
            });
          }
          React.useEffect(() => {
            if (sidebarCommand) contentAction(sidebarCommand.action, sidebarCommand.item, sidebarCommand.opener);
          }, [sidebarCommand]);
          function submit(event) {
            event.preventDefault();
            if (dialog.kind === 'sessionRename') return sessionAction('session.rename', dialog.item, { title: name.trim() });
            return work(async () => {
              const item = dialog.item;
              if (dialog.kind === 'newFolder') await api('files.mkdir', { path: joinPath(path, name) });
              else if (dialog.kind === 'newFile') await upload(new Blob([text]), joinPath(path, name));
              else if (dialog.kind === 'file') { setProgress({ done: 0, total: new Blob([text]).size }); await upload(new Blob([text]), item.path, dialog.value.revision); }
              else if (dialog.kind === 'delete') await api('files.delete', { path: item.path, revision: item.revision, confirm: true });
              else await api('files.rename', { path: item.path, revision: item.revision, to: dialog.kind === 'move' ? joinPath(name, item.name) : joinPath(parentPath(item.path), name) });
              if (alive.current) { setDialog(null); setMessage(t(dialog.kind === 'delete' ? 'contentRecycled' : 'contentDone')); await load(); }
            });
          }
          const progressView = progress && h('div', { className: 'lanw-content-progress', role: 'status' }, h('span', null, `${t('contentBusy')} · ${progress.total ? Math.floor(progress.done / progress.total * 100) : 100}%`), h(Button, { onClick: () => { cancel.current = true; } }, t('contentCancelTransfer')));
          const dialogTitle = dialog && t(({ file: 'contentFile', sessionRename: 'contentRename', rename: 'contentRename', move: 'contentMove', delete: 'contentDelete', newFolder: 'contentNewFolder', newFile: 'contentNewFile' })[dialog.kind]);
          const shortForm = dialog && (['sessionRename', 'rename', 'move', 'delete', 'newFolder'].includes(dialog.kind) || dialog.kind === 'file' && dialog.value.binary);
          const editable = dialog && ['file', 'newFolder', 'newFile', 'rename', 'move', 'delete', 'sessionRename'].includes(dialog.kind) && !(dialog.kind === 'file' && dialog.value.binary);
          const transferControls = h(React.Fragment, null,
            h('input', { type: 'file', ref: uploadInput, multiple: true, hidden: true, onChange: selectedUpload, 'data-content-upload': true }),
            download && h('a', { ref: downloadLink, href: download.url, download: download.name, hidden: true }));
          const conditions = mode === 'sessions' ? sessionFilters : fileFilters, defaults = mode === 'sessions' ? sessionDefaults : fileDefaults;
          const conditionCount = filterCount(conditions, defaults), searchValue = mode === 'sessions' ? query : fileQuery;
          const summary = mode === 'sessions' ? [t({ messages: 'filterMessages', all: 'filterAllContent', empty: 'filterEmpty' }[conditions.content]), t({ active: 'filterActive', archived: 'filterArchived', all: 'filterAny' }[conditions.archive]), conditions.status !== 'all' && t(conditions.status === 'running' ? 'contentRunning' : 'contentIdle')] : [t(conditions.kind === 'directory' ? 'contentFolder' : conditions.kind === 'file' ? 'contentFile' : conditions.kind === 'link' ? 'contentLink' : 'filterAny'), conditions.extensions];
          if (conditions.from || conditions.to) summary.push(`${conditions.from || '…'} – ${conditions.to || '…'}`);
          if (mode === 'files' && ['all', 'directory'].includes(conditions.kind)) summary.push(t(conditions.emptyFolders === 'only' ? 'filterFoldersOnly' : conditions.emptyFolders === 'exclude' ? 'filterFoldersHide' : 'filterFoldersInclude'));
          if (mode === 'sessions' && conditions.searchScope !== 'all') summary.push(t({ title: 'filterScopeTitle', member: 'filterScopeMember', id: 'filterScopeId' }[conditions.searchScope]));
          if (conditions.sort !== defaults.sort) summary.push(t({ title: 'filterName', 'name-desc': 'filterNameDesc', 'updated-desc': 'filterNewest', 'updated-asc': 'filterOldest', 'size-desc': 'filterLargest' }[conditions.sort]));
          const clearConditions = () => { if (mode === 'sessions') { setQuery(''); setSessionFilters(sessionDefaults); } else { setFileQuery(''); setFileFilters(fileDefaults); } setOffset(0); };
          return h('div', { ref: root, className: 'lanw-stack lanw-content-manager', 'data-admin-content': true, 'data-member-content': own || undefined, 'aria-busy': loading || pending },
            sidebarCommand && !dialog && h(EditDialog, { title: t('contentManage'), subtitle: sidebarCommand.item.name, pending, className: 'lanw-content-action-dialog', confirmChanges: false, returnFocusTo: sidebarCommand.opener, onClose: onSidebarClose }, transferControls,
              h('div', { className: 'lanw-content-details' }, error && h('p', { role: 'alert', className: 'lanw-error' }, error), notice && h('p', { role: 'status' }, notice), progressView, pending && !progress && h('p', { role: 'status' }, t('contentBusy')))),
            !sidebarCommand && h(React.Fragment, null,
            filtersOpen && h(ContentFilters, { mode, value: conditions, onClose: () => setFiltersOpen(false), onApply: value => { if (mode === 'sessions') setSessionFilters(value); else setFileFilters(value); setOffset(0); } }),
            recycleOpen && selectedUser && h(RecycleBin, { user: selectedUser, request, contentEndpoint, onClose: () => { setRecycleOpen(false); void load(); } }),
            !pageMode && h('p', { className: 'lanw-help' }, t('contentNote')),
            !own && h('div', { className: 'lanw-content-scope' },
              h('div', { className: 'lanw-field lanw-content-member' }, h('span', null, t('contentMember')), h(MemberPicker, { users, userPage, request, active, includeHistory: !own && historicalAccounts, value: selected ?? '', disabled: pending, testId: 'data-content-member', label: t('contentMember'), allowAll: mode === 'sessions', onSelect: row => { setChosenUser(row); setUserId(row?.id ?? ''); openDirectory(''); } })),
              h(Button, { className: 'lanw-iconbutton', disabled: loading || pending, 'aria-label': t('contentRefresh'), 'aria-busy': loading, 'data-refresh-account': true, onClick: load }, h(IconRefreshOutlineRegular))),
            (mode === 'files' || own || !pageMode) && h('div', { className: 'lanw-content-toolbar' },
              !pageMode && h('div', { className: 'lanw-tabs', role: 'tablist' }, ['sessions', 'files'].map(value => h(Button, { key: value, role: 'tab', 'aria-selected': mode === value, 'data-content-mode': value, disabled: pending || own && !fileAccess && value === 'files', onClick: () => { setMode(value); setOffset(0); setPath(''); setMessage(''); } }, h(NavigationLabel, { id: value }, t(value === 'sessions' ? 'contentSessions' : 'contentFiles'))))),
              h('div', { className: 'lanw-content-file-actions' }, mode === 'files' && h(React.Fragment, null,
                h(Button, { disabled: pending, className: 'lanw-btn-secondary', onClick: () => setRecycleOpen(true), 'data-open-recycle': true }, t('recycleBin')), h(Button, { disabled: pending, className: 'lanw-btn-secondary', onClick: () => startDialog('newFolder') }, t('contentNewFolder')), h(Button, { disabled: pending, className: 'lanw-btn-secondary', onClick: () => startDialog('newFile') }, t('contentNewFile')), h(Button, { disabled: pending, primary: true, onClick: () => chooseUpload() }, t('contentUpload'))),
                own && h(Button, { className: 'lanw-iconbutton', disabled: loading || pending, 'aria-label': t('contentRefresh'), 'aria-busy': loading, 'data-refresh-account': true, onClick: load }, h(IconRefreshOutlineRegular)))),
            own && !fileAccess && h('p', { className: 'lanw-help' }, t('ownFilesDisabled')),
            mode === 'files' && h('div', { className: 'lanw-content-location' },
              h('nav', { className: 'lanw-content-path', 'aria-label': t('contentRoot') }, h('ol', null,
                h('li', null, path ? h(Button, { disabled: pending, onClick: () => openDirectory('') }, h(NavigationLabel, { id: 'files' }, t('contentRoot'))) : h('span', { 'aria-current': 'location' }, h(NavigationLabel, { id: 'files' }, t('contentRoot')))),
                path.split('/').filter(Boolean).map((part, index, parts) => h('li', { key: index }, index === parts.length - 1 ? h('span', { 'aria-current': 'location' }, h(NavigationLabel, { id: 'files' }, part)) : h(Button, { disabled: pending, onClick: () => openDirectory(parts.slice(0, index + 1).join('/')) }, h(NavigationLabel, { id: 'files' }, part)))))),
              path && h(Button, { disabled: pending, className: 'lanw-content-up', onClick: () => openDirectory(parentPath(path)) }, t('contentUp'))),
            h('div', { className: 'lanw-content-toolbar lanw-content-filters' },
              h(Field, { label: t(mode === 'sessions' ? 'contentSearch' : 'fileSearch') }, h('input', { value: searchValue, maxLength: 200, placeholder: t(mode === 'files' ? 'fileSearchHint' : { all: 'sessionSearchHint', title: 'filterScopeTitle', member: 'filterScopeMember', id: 'filterScopeId' }[sessionFilters.searchScope]), 'data-content-search': mode, onChange: event => { if (mode === 'sessions') setQuery(event.target.value); else setFileQuery(event.target.value); setOffset(0); } })),
              h(Button, { className: 'lanw-btn-secondary lanw-filter-button', disabled: pending, 'aria-haspopup': 'dialog', 'aria-expanded': filtersOpen, 'data-content-advanced': mode, onClick: () => setFiltersOpen(true) }, t('advancedFilters'), conditionCount > 0 && h('span', { className: 'lanw-filter-count' }, conditionCount))),
            h('div', { className: 'lanw-filter-summary', 'data-content-filter-summary': true }, h('span', null, !conditionCount ? t(mode === 'sessions' ? 'filterDefaultSummary' : 'fileDefaultSummary') : summary.filter(Boolean).join(' · ')), (conditionCount > 0 || searchValue) && h(Button, { disabled: pending, 'data-content-clear': true, onClick: clearConditions }, t('filterClear'))),
            !dialog && transferControls,
            progressView,
            !dialog && error && h('p', { role: 'alert', className: 'lanw-help lanw-error' }, error),
            notice && h('p', { role: 'status', className: 'lanw-help' }, notice),
            (loading || result.contextKey !== contextKey) && h('p', { role: 'status', className: 'lanw-help' }, t('loading')),
            view.items.length ? h('div', { className: 'lanw-tablewrap' }, h('table', { className: 'lanw-content-table' },
              h('thead', null, h('tr', null, [mode === 'sessions' ? 'contentRowTitle' : 'contentName', mode === 'sessions' ? 'contentOwner' : 'contentType', mode === 'sessions' ? 'contentStatus' : 'contentSize', 'contentActions'].map(key => h('th', { key }, t(key))))),
              h('tbody', null, view.items.map(item => h('tr', { key: item.sessionId ?? item.path },
                h('td', null, h(Button, { className: 'lanw-file-name', 'data-content-entry': item.sessionId ?? item.path, disabled: pending || mode === 'files' && !['directory', 'file'].includes(item.kind), onClick: () => mode === 'sessions' ? historyDialog(item) : item.kind === 'directory' ? openDirectory(item.path) : nativeDialog('files.preview', { path: item.path }) }, h('span', null, item.title ?? item.name))),
                h('td', null, mode === 'sessions' ? item.displayName : t(item.kind === 'directory' ? 'contentFolder' : item.kind === 'link' ? 'contentLink' : 'contentFile')),
                h('td', null, mode === 'sessions' ? t(item.archived ? 'contentArchivedState' : item.running ? 'contentRunning' : 'contentIdle') : item.kind === 'file' ? size(item.size) : '—'),
                h('td', null, h(ContentActions, { item, mode, pending, fileAccess: !own || fileAccess, onAction: contentAction }))))))) : !loading && result.contextKey === contextKey && h('div', { className: 'lanw-stack' }, h('p', { className: 'lanw-empty' }, t(mode === 'sessions' ? 'contentEmpty' : conditionCount || searchValue ? 'contentNoFiles' : 'contentEmptyFolder')), (mode === 'sessions' || conditionCount || searchValue) && h('p', { className: 'lanw-help' }, t(mode === 'sessions' ? 'contentEmptyHint' : 'contentFileEmptyHint'))),
            h('div', { className: 'lanw-row lanw-pagination' }, h('span', { className: 'lanw-help' }, `${t('contentCount')} ${number(view.total)}`), h(Button, { disabled: !offset || loading || pending, onClick: () => setOffset(value => Math.max(0, value - pageSize)) }, t('contentPrev')), h('span', { className: 'lanw-help' }, `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(view.total / pageSize))}`), h(Button, { disabled: offset + pageSize >= view.total || loading || pending, onClick: () => setOffset(value => value + pageSize) }, t('contentNext'))),
            ),
            dialog && h(EditDialog, { title: dialogTitle, subtitle: dialog.kind.startsWith('session') || dialog.kind === 'history' ? `${dialog.item.title} · ${dialog.item.displayName}` : `${selectedUser?.displayName ?? ''} · ${(dialog.item?.path ?? path) || t('contentRoot')}`, pending, returnFocusTo: dialog.opener, className: shortForm ? 'lanw-content-action-dialog' : '', confirmChanges: !shortForm, onClose: () => { setDialog(null); setProblem(''); onSidebarClose?.(); }, footer: editable && h(Button, { primary: true, type: 'submit', form: 'lanw-content-form', disabled: pending || dialog.kind === 'file' && text === dialog.value.text }, t(dialog.kind === 'delete' ? 'contentDelete' : dialog.kind.startsWith('new') ? 'contentCreate' : 'contentSave')) },
              transferControls,
              h('div', { className: 'lanw-content-details' },
                error && h('p', { role: 'alert', className: 'lanw-help lanw-error' }, error), progressView,
                h('form', { id: 'lanw-content-form', className: 'lanw-form', onSubmit: submit },
                  dialog.kind === 'delete' ? h('p', null, t('contentConfirmDelete')) : dialog.kind === 'file' && dialog.value.binary ? h(React.Fragment, null, h('p', { className: 'lanw-help' }, t('contentBinary')), h(Button, { disabled: pending, onClick: () => downloadFile(dialog.item) }, t('contentDownload'))) : h(React.Fragment, null,
                    dialog.kind !== 'file' && h(Field, { label: t(dialog.kind === 'move' ? 'contentDestination' : dialog.kind === 'sessionRename' ? 'contentRowTitle' : 'contentName') }, h('input', { value: name, 'data-modal-autofocus': true, required: dialog.kind !== 'move', disabled: pending, maxLength: dialog.kind === 'sessionRename' ? 120 : 4096, onChange: event => setName(event.target.value), 'data-content-name': true })),
                    (dialog.kind === 'file' || dialog.kind === 'newFile') && h(Field, { label: t('contentText') }, h('textarea', { className: 'lanw-content-editor', value: text, disabled: pending, onChange: event => setText(event.target.value), 'data-content-text': true })))))));
        }

        function PageHeading({ title, description, actions, level = 'h2' }) {
          return h('header', { className: 'lanw-page-heading' }, h('div', { className: 'lanw-title-row' }, h(level, null, title), actions), description && h('p', { className: 'lanw-help' }, description));
        }
        function EditDialog({ title, subtitle, sections, activeSection, onSelect, pending, onClose, children, footer, progress, setupStep, hideCancel = false, className = '', confirmChanges = true, returnFocusTo, editorKind = 'edit', resetKey, draftRevision = 0 }) {
          const dialog = React.useRef(null), busy = React.useRef(pending);
          const body = React.useRef(null);
          React.useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [activeSection]);
          const [dirty, setDirty] = React.useState(false), [confirmClose, setConfirmClose] = React.useState(false);
          React.useEffect(() => { if (draftRevision > 0 && confirmChanges) setDirty(true); }, [draftRevision, confirmChanges]);
          React.useEffect(() => {
            setDirty(false); setConfirmClose(false);
            if (resetKey && body.current) { body.current.scrollTop = 0; body.current.querySelector('[data-invite-result] input')?.focus({ preventScroll: true }); }
          }, [resetKey]);
          busy.current = pending;
          React.useEffect(() => {
            const node = dialog.current, opener = returnFocusTo ?? node?.ownerDocument.activeElement;
            if (node && !node.open) node.showModal();
            node?.querySelector('[data-modal-autofocus]')?.focus({ preventScroll: true });
            return () => {
              if (node?.open) node.close();
              Promise.resolve().then(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
            };
          }, []);
          React.useEffect(() => {
            if (setupStep === undefined || !body.current) return;
            body.current.scrollTop = 0;
            body.current.querySelector(`[data-account-step="${setupStep}"] :is(input:not([type=hidden]),select,textarea,button)`)?.focus({ preventScroll: true });
          }, [setupStep]);
          function requestClose() { if (busy.current) return; if (dirty) setConfirmClose(true); else onClose(); }
          return h('dialog', { ref: dialog, className: `lanw-editdialog ${className}`, 'data-edit-dialog': true, 'data-account-editor': editorKind, 'aria-labelledby': 'lanw-edit-title',
            onKeyDown: containDialogEscape, onCancel: event => { event.preventDefault(); event.stopPropagation?.(); if (confirmClose) setConfirmClose(false); else requestClose(); }, onClick: event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose(); } },
          }, h('div', { className: 'lanw-panelhead' }, h('div', { className: 'lanw-edit-heading' }, h('h2', { id: 'lanw-edit-title' }, title), subtitle && h('p', { className: 'lanw-help' }, subtitle)), h(Button, { disabled: pending, 'data-close-editor': true, onClick: requestClose }, t('closePanel'))),
            progress,
            confirmClose && h('section', { className: 'lanw-stack lanw-notice', 'data-discard-edit': true, role: 'alert' }, h('p', null, t('discardEdit')), h('div', { className: 'lanw-row' }, h(Button, { disabled: pending, onClick: () => setConfirmClose(false) }, t('keepEditing')), h(Button, { disabled: pending, onClick: onClose }, t('discardChanges')))),
            h('div', { className: 'lanw-edit-layout' }, sections && h('nav', { className: 'lanw-access-nav', 'aria-label': t('accountAuthorization') }, [...new Set(sections.map(section => section.group))].map(group =>
              h('div', { key: group || 'default', className: 'lanw-access-group', 'data-access-group': group }, group && h('h3', { className: 'lanw-access-group-title' }, t(group)),
                sections.filter(section => section.group === group).map(section => h(Button, { key: section.id, disabled: pending, 'data-access-section': section.id, 'aria-current': activeSection === section.id ? 'page' : undefined, 'aria-controls': `lanw-access-${section.id}`, onClick: () => onSelect(section.id) }, h(NavigationLabel, { id: section.id }, section.label)))))),
              h('div', { ref: body, className: 'lanw-edit-body', onInvalidCapture: event => { const pane = event.target.closest('[data-access-panel]'); if (pane && onSelect) { event.preventDefault(); onSelect(pane.dataset.accessPanel); requestAnimationFrame(() => event.target.focus()); } }, onClickCapture: event => { const owner = event?.target?.closest?.('[data-edit-dialog]'); if (dialog.current && owner && owner !== dialog.current) return; if (confirmChanges && event.target.closest('[role=switch]')) { setDirty(true); setConfirmClose(false); } }, onChangeCapture: event => { const owner = event?.target?.closest?.('[data-edit-dialog]'); if (dialog.current && owner && owner !== dialog.current) return; if (event?.target?.closest('[data-member-picker]') || event?.target?.closest('[data-edit-filter]')) return; if (confirmChanges) setDirty(true); setConfirmClose(false); } }, sections && h(PageHeading, { title: sections.find(section => section.id === activeSection)?.label, description: sections.find(section => section.id === activeSection)?.description }), children)),
            h('div', { className: 'lanw-edit-footer' }, !hideCancel && h(Button, { disabled: pending, onClick: requestClose }, t('cancelEdit')), footer));
        }
        function Icon({ size, active }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('rect', { x: 8, y: 3, width: 8, height: 6, rx: 1.5 }), h('path', { d: 'M12 9v5M5 14h14M5 14v3m14-3v3' }),
            h('rect', { x: 2, y: 17, width: 6, height: 4, rx: 1 }), h('rect', { x: 16, y: 17, width: 6, height: 4, rx: 1 }));
        }

        function SetupGuide({ value, home, pending, error, onComplete, onReload }) {
          const [step, setStep] = React.useState(0), [host, setHost] = React.useState(() => new URL(value.memberOrigin).hostname);
          const [root, setRoot] = React.useState(home.configuredRoot ?? home.root ?? '');
          const [createRecommended, setCreateRecommended] = React.useState(false);
          const steps = ['setupAdministrator', 'setupDirectories', 'setupEntry', 'setupReview'];
          const entry = new URL(value.memberOrigin); entry.hostname = host; entry.pathname = '/lan/';
          const next = event => {
            const section = event.currentTarget.form?.querySelector(`[data-setup-step="${step}"]`);
            const invalid = [...section.querySelectorAll('input,select,textarea')].find(input => !input.checkValidity());
            if (invalid) { invalid.reportValidity(); return; }
            setStep(current => Math.min(current + 1, 2));
          };
          return h('div', { className: 'lanw-stack lanw-setup-guide', 'data-first-run-setup': true },
            h(PageHeading, { title: t('setupTitle'), description: t('setupPendingNote') }),
            h('ol', { className: 'lanw-first-steps', 'aria-label': t('setupTitle') }, steps.map((label, index) => h('li', { key: label, 'aria-current': index === step + 1 ? 'step' : undefined }, h('span', null, `${index < step + 1 ? '✓' : index + 1} · ${t(label)}`)))),
            error && h('div', { role: 'alert', className: 'lanw-notice lanw-error' }, h('p', null, ['SETUP_CONFLICT', 'HOME_DIRECTORY_CONFLICT'].includes(error.code) ? t('setupConflict') : error.message || t('requestFailed')), h(Button, { disabled: pending, onClick: onReload }, t('setupReload'))),
            h('form', { 'data-setup-form': true, onInvalidCapture: event => { const pane = event.target.closest('[data-setup-step]'); if (pane) setStep(Number(pane.dataset.setupStep)); }, onSubmit: event => {
              event.preventDefault(); if (pending) return; const data = new FormData(event.currentTarget);
              const sharedDirectories = JSON.parse(data.get('sharedDirectories') || '[]');
              void onComplete({ expectedRevision: value.revision, homeRevision: home.revision, root: root.trim(), memberHost: host.trim(), sharedDirectories, createRecommended: createRecommended && sharedDirectories.some(row => row.path === value.recommendedSharedDirectory) });
            } }, h('fieldset', { className: 'lanw-fieldset lanw-stack', disabled: pending },
              h('section', { hidden: step !== 0, 'data-setup-step': 0, className: 'lanw-stack' },
                h(Field, { label: t('setupRoot'), description: t('setupRootNote') }, h('input', { value: root, required: true, 'data-setup-root': true, onChange: event => setRoot(event.target.value) })),
                h('h3', null, t('setupShared')), h('p', { className: 'lanw-help' }, t('setupSharedNote')),
                h(DirectoryPolicy, { panel: true, account: { access: { sharedDirectories: value.sharedDirectories } }, recommendedPath: value.recommendedSharedDirectory, onRecommended: () => setCreateRecommended(true) })),
              h('section', { hidden: step !== 1, 'data-setup-step': 1, className: 'lanw-stack' },
                h(Field, { label: t('setupHost'), description: t('setupHostHint') }, h('input', { value: host, required: true, maxLength: 253, spellCheck: false, 'data-setup-host': true, onChange: event => setHost(event.target.value) })),
                value.suggestedHost && h(Button, { onClick: () => setHost(value.suggestedHost), type: 'button' }, t('setupSuggestedHost')),
                h(Field, { label: t('setupPort'), description: t('setupPortNote') }, h('input', { value: value.port, readOnly: true })),
                h('p', { className: 'lanw-help' }, t('setupLink')), h('code', null, entry.href)),
              h('section', { hidden: step !== 2, 'data-setup-step': 2, className: 'lanw-stack' },
                h('dl', { className: 'lanw-dl' }, h('dt', null, t('setupModels')), h('dd', null, value.modelVariants), h('dt', null, t('setupRoot')), h('dd', null, root)),
                h('p', { className: 'lanw-help' }, t(value.modelVariants ? 'setupModelsNote' : 'setupNoModels')),
                h(Button, { type: 'button', onClick: onReload }, t('refresh')),
                h('h3', null, t('setupLink')), h('code', null, entry.href), h('p', { className: 'lanw-help' }, `${t('setupFallback')}: ${value.fallbackUrl}`)),
              h('div', { className: 'lanw-setup-actions' }, h(Button, { type: 'button', disabled: step === 0, onClick: () => setStep(current => Math.max(current - 1, 0)) }, t('accountSetupBack')),
                step < 2 ? h(Button, { primary: true, type: 'button', onClick: next, 'data-setup-next': true }, t('accountSetupNext')) : h(Button, { primary: true, type: 'submit', 'data-setup-complete': true }, t('setupFinish'))))));
        }

        function Workspace({ close, AccountSection, identity, initialSnapshot, fileAction } = {}) {
          useLocale();
          const expectedIdentity = identity ?? window.__DSH_LAN_MEMBER__?.user;
          const validInitial = window.__DSH_LAN_MEMBER__ && initialSnapshot?.user?.id === expectedIdentity?.id && initialSnapshot?.user?.role === expectedIdentity?.role && Array.isArray(initialSnapshot?.projects) && Array.isArray(initialSnapshot?.routes);
          const startingSnapshot = React.useRef(validInitial ? initialSnapshot : null);
          const [previewReturn] = React.useState(() => { const saved = pendingPreviewReturn; pendingPreviewReturn = null; return saved; });
          const [status, setStatus] = React.useState(() => startingSnapshot.current ? { initialized: true } : null);
          const [user, setUser] = React.useState(() => identity ?? window.__DSH_LAN_MEMBER__?.user ?? null);
          const [snapshot, setSnapshot] = React.useState(() => {
            const cached = memberSnapshot?.user?.id === expectedIdentity?.id && memberSnapshot?.user?.role === expectedIdentity?.role ? memberSnapshot : null;
            return startingSnapshot.current ? mergeWorkspaceSnapshot(cached, startingSnapshot.current) : cached;
          });
          const snapshotRef = React.useRef(snapshot), snapshotEpoch = React.useRef(0), detailRequests = React.useRef({});
          const [detailState, setDetailState] = React.useState({});
          const [pending, setPending] = React.useState('status');
          const [error, setError] = React.useState(null);
          const [notice, setNotice] = React.useState(null);
          const [authMode, setAuthMode] = React.useState('login');
          const [remember, setRemember] = React.useState(true);
          const [tab, setTab] = React.useState(previewReturn ? previewReturn.self ? 'content' : 'admin' : (identity ?? window.__DSH_LAN_MEMBER__?.user)?.role === 'member' ? 'account' : 'admin');
          const [adminTab, setAdminTab] = React.useState(previewReturn ? 'content' : 'accounts');
          const [contentMode, setContentMode] = React.useState(previewReturn?.mode ?? 'sessions');
          const [sharingTab, setSharingTab] = React.useState('resources');
          const [visitedAdminTabs, setVisitedAdminTabs] = React.useState({ accounts: true, ...(previewReturn ? { content: true } : {}) });
          const [accountPanel, setAccountPanel] = React.useState('');
          const [accountOperation, setAccountOperation] = React.useState(null);
          const [bulkSelection, setBulkSelection] = React.useState({}), [bulkScopes, setBulkScopes] = React.useState([]);
          const [bulkTicket, setBulkTicket] = React.useState(null), [batchSelecting, setBatchSelecting] = React.useState(false);
          const batchSelectionSequence = React.useRef(0);
          const [accountSetupStep, setAccountSetupStep] = React.useState(0);
          const [accountAccessTab, setAccountAccessTab] = React.useState('models');
          const [accountQuery, setAccountQuery] = React.useState('');
          const [accountPage, setAccountPage] = React.useState(0), [accountPageSize, setAccountPageSize] = React.useState(10), [accountFilter, setAccountFilter] = React.useState('all');
          React.useEffect(() => { batchSelectionSequence.current++; setBulkSelection({}); setBulkTicket(null); setBatchSelecting(false); }, [accountQuery, accountFilter]);
          const [usageQuery, setUsageQuery] = React.useState(''), [usageFilter, setUsageFilter] = React.useState('all');
          const [usagePage, setUsagePage] = React.useState(0), [usagePageSize, setUsagePageSize] = React.useState(10);
          const [usageResult, setUsageResult] = React.useState(null), [usageLoading, setUsageLoading] = React.useState(false), [usageProblem, setUsageProblem] = React.useState(''), [usageRetry, setUsageRetry] = React.useState(0);
          const usageSequence = React.useRef(0);
          const [accountResult, setAccountResult] = React.useState(null), [accountLoading, setAccountLoading] = React.useState(false), [accountProblem, setAccountProblem] = React.useState(''), [accountRetry, setAccountRetry] = React.useState(0);
          const accountSequence = React.useRef(0);
          const [selectedId, setSelectedId] = React.useState('');
          const [adminUserId, setAdminUserId] = React.useState('');
          const [editorAccount, setEditorAccount] = React.useState(null);
          const [grantTemplate, setGrantTemplate] = React.useState(null), [grantDraftVersion, setGrantDraftVersion] = React.useState(0);
          const [invite, setInvite] = React.useState(null);
          // Only CSRF (and an optional legacy bearer) stays in panel memory.
          // Persistent sessions use an HttpOnly cookie; local storage holds a username only.
          const auth = React.useRef(null);
          const mounted = React.useRef(false);
          const busy = React.useRef(false);
          const controllers = React.useRef(new Set());
          const timers = React.useRef(new Set());
          const clearSession = React.useCallback(() => {
            memberSnapshot = null; pendingPreviewReturn = null;
            snapshotEpoch.current++; snapshotRef.current = null; detailRequests.current = {};
            auth.current = null;
            clearDesktopSession();
            if (!mounted.current) return;
            batchSelectionSequence.current++; setBulkSelection({}); setBulkTicket(null); setBatchSelecting(false); setBulkScopes([]);
            setUser(null); setSnapshot(null); setDetailState({}); setInvite(null); setTab('admin'); setAccountOperation(null);
            setAdminTab('accounts'); setVisitedAdminTabs({ accounts: true }); setAccountPanel(''); setAccountQuery(''); setAccountPage(0); setAccountFilter('all');
            setSelectedId(''); setAdminUserId(''); setEditorAccount(null); setGrantTemplate(null); setNotice(null);
          }, []);

          const request = React.useCallback(async (action, fields = {}, ownerSetup = false, bearer = '', sessionOverride) => {
            const controller = new AbortController();
            controllers.current.add(controller);
            const timer = setTimeout(() => controller.abort(), action === 'admin.checkIsolation' ? 60000 : 20000);
            timers.current.add(timer);
            const headers = { 'Content-Type': 'application/json' };
            const session = sessionOverride ?? auth.current;
            if (bearer) headers.Authorization = `Bearer ${bearer}`;
            if (!PUBLIC_ACTIONS.has(action)) {
              if (!session) {
                clearTimeout(timer); timers.current.delete(timer); controllers.current.delete(controller);
                throw failure('UNAUTHENTICATED', t('expired'));
              }
              if (session.token) headers.Authorization = `Bearer ${session.token}`;
              // The member ingress authenticates every POST before decoding the
              // business action, including read-only snapshot requests.
              if (window.__DSH_LAN_MEMBER__ || !READ_ACTIONS.has(action)) {
                if (!session.csrf) {
                  clearTimeout(timer); timers.current.delete(timer); controllers.current.delete(controller);
                  throw failure('CSRF_REQUIRED', t('csrfMissing'));
                }
                headers['X-Lan-CSRF'] = session.csrf;
              }
            }
            // Only the explicit first-administrator submit calls request with this flag.
            if (['bootstrap', 'owner.recoverAdministrator'].includes(action) && ownerSetup === true) headers['X-Lan-Owner-Setup'] = 'confirm';
            try {
              const response = await send({
                method: 'POST', credentials: 'same-origin', headers,
                body: JSON.stringify({ action, ...fields }), signal: controller.signal,
              });
              let envelope;
              try { envelope = await response.json(); }
              catch (_) {
                if (response.status === 401) { clearSession(); throw failure('UNAUTHENTICATED', t('expired')); }
                throw failure('INVALID_RESPONSE', t('invalidResponse'));
              }
              if (response.status === 401) clearSession();
              if (!response.ok || envelope?.ok !== true) {
                const problem = failure(envelope?.error?.code || `HTTP_${response.status}`, envelope?.error?.message || t('requestFailed'));
                problem.status = response.status; throw problem;
              }
              if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) throw failure('INVALID_RESPONSE', t('invalidResponse'));
              return envelope.result;
            } catch (err) {
              if (err.name === 'AbortError') throw failure('REQUEST_CANCELLED', t('timeout'));
              if (err.code) throw err;
              throw failure('NETWORK_ERROR', [t('requestFailed'), browserHint].filter(Boolean).join(' '));
            } finally {
              clearTimeout(timer); timers.current.delete(timer); controllers.current.delete(controller);
            }
          }, [clearSession]);

          const loadSnapshot = React.useCallback(async () => {
            const epoch = ++snapshotEpoch.current;
            detailRequests.current = {};
            const value = await request('snapshot', { section: 'base' });
            if (!value?.user?.id || !Array.isArray(value.projects) || !Array.isArray(value.routes)) {
              throw failure('INVALID_RESPONSE', t('invalidResponse'));
            }
            if (mounted.current && epoch === snapshotEpoch.current) {
              const merged = mergeWorkspaceSnapshot(snapshotRef.current, value);
              snapshotRef.current = merged;
              publishBranding(value.branding); if (window.__DSH_LAN_MEMBER__) memberSnapshot = merged;
              setSnapshot(merged); setUser(value.user); setDetailState({});
            }
            return value;
          }, [request]);

          const ensureDetails = React.useCallback((section, force = false) => {
            if (!auth.current || !snapshotRef.current || busy.current) return Promise.resolve();
            const existing = detailRequests.current[section];
            if (existing?.pending) return existing.pending;
            if (existing && !force) return Promise.resolve();
            const epoch = snapshotEpoch.current, id = snapshotRef.current.user.id;
            const entry = {}; detailRequests.current[section] = entry;
            setDetailState(old => ({ ...old, [section]: { loading: true } }));
            entry.pending = request('snapshot', { section }).then(value => {
              if (!mounted.current || epoch !== snapshotEpoch.current || snapshotRef.current?.user.id !== id) return;
              if (value?.user?.id !== id || !Array.isArray(value.projects) || !Array.isArray(value.routes)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
              const merged = mergeWorkspaceSnapshot(snapshotRef.current, value);
              snapshotRef.current = merged;
              if (window.__DSH_LAN_MEMBER__) memberSnapshot = merged;
              setSnapshot(merged); setUser(value.user);
              setDetailState(old => ({ ...old, [section]: { ready: true } }));
            }).catch(error => {
              if (mounted.current && epoch === snapshotEpoch.current) setDetailState(old => ({ ...old, [section]: { error } }));
            }).finally(() => { entry.pending = null; });
            return entry.pending;
          }, [request]);

          function detailNotice(section) {
            const state = detailState[section];
            if (!state || state.ready) return null;
            return h('div', { className: 'lanw-row lanw-help', 'data-loading-section': section, role: state.error ? 'alert' : 'status' },
              state.error ? state.error.message || t('requestFailed') : t('loading'),
              state.error && actionButton(t('retry'), { onClick: () => ensureDetails(section, true) }));
          }

          React.useEffect(() => {
            mounted.current = true;
            busy.current = true;
            const prefetched = startupStatus; startupStatus = undefined;
            (window.__DSH_LAN_MEMBER__ ? Promise.resolve({ initialized: true }) : prefetched ?? request('status')).then(async value => {
              if (typeof value?.initialized !== 'boolean') throw failure('INVALID_RESPONSE', t('invalidResponse'));
              if (!mounted.current) return;
              setStatus(value);
              if (!window.__DSH_LAN_MEMBER__ && value.initialized && memberEntryUrl(value.memberUrl)) return;
              if (value.initialized) {
                let restored;
                try {
                  if (window.__DSH_LAN_MEMBER__) {
                    const member = window.__DSH_LAN_MEMBER__;
                    if (typeof member.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(member.csrf)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                    restored = { user: member.user, csrf: member.csrf, cookieSession: true };
                  } else {
                    // In the Desktop window the sign-in is revalidated from this
                    // window's stored bearer session; a rejected one is forgotten.
                    const stored = readDesktopSession();
                    if (stored) {
                      try {
                        const value = await request('auth.restore', {}, false, stored.token);
                        if (!value?.user?.id) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                        restored = { user: value.user, csrf: stored.csrf, token: stored.token };
                      } catch (error) {
                        if (error?.status !== 401 && error?.code !== 'UNAUTHENTICATED') throw error;
                        clearDesktopSession();
                      }
                    }
                    restored ??= await request('auth.restore');
                  }
                }
                catch (error) { if (error.status === 401 || error.code === 'UNAUTHENTICATED') return; throw error; }
                if (!mounted.current) return;
                auth.current = sessionAuth(restored); setUser(restored.user);
                setStatus(previous => ({ ...previous, initialized: true }));
                if (!startingSnapshot.current) await loadSnapshot();
              }
            }).catch(err => { if (mounted.current) setError(err); }).finally(() => {
              busy.current = false;
              if (mounted.current) setPending('');
            });
            return () => {
              mounted.current = false;
              snapshotEpoch.current++;
              controllers.current.forEach(controller => controller.abort()); controllers.current.clear();
              timers.current.forEach(timer => clearTimeout(timer)); timers.current.clear();
              auth.current = null;
            };
          }, [request]);

          // The native account owner revalidates on every open. Share that
          // receipt without issuing a second serial read, and never let its
          // background result replace a later manual refresh or saved policy.
          React.useEffect(() => {
            if (!validInitial || !mounted.current || busy.current || snapshotEpoch.current !== 0) return;
            const merged = mergeWorkspaceSnapshot(snapshotRef.current, initialSnapshot);
            snapshotRef.current = merged; memberSnapshot = merged;
            setSnapshot(merged); setUser(merged.user);
          }, [initialSnapshot]);

          async function run(action, fields = {}, options = {}) {
            if (busy.current) return false;
            busy.current = true; setPending(action); setError(null); setNotice(null);
            try {
              const result = action === 'snapshot' ? await loadSnapshot() : await request(action, fields, options.ownerSetup === true);
              if (!mounted.current) return false;
              if (['bootstrap', 'login', 'redeem'].includes(action)) {
                auth.current = sessionAuth(result);
                // Desktop windows keep their bearer session in this window so the
                // next start restores silently; a cookie session stores nothing.
                writeDesktopSession(auth.current);
                rememberUsername(fields.username, fields.remember === true);
                setUser(result.user); setStatus(previous => ({ ...previous, initialized: true }));
                await loadSnapshot();
              } else if (action === 'admin.getUser') {
                if (!result.user?.id) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                setEditorAccount(result.user); setGrantDraftVersion(0);
              } else if (action === 'owner.recoverAdministrator') {
                clearSession(); setAuthMode('login'); setNotice('administratorRecovered');
              } else if (action === 'admin.updateUser' && result.user?.id === user?.id && (result.roleChanged === true || result.user.disabled)) {
                clearSession(); setNotice('identityChanged');
                if (window.__DSH_LAN_MEMBER__) window.location.assign(`${result.user.role === 'admin' ? '/lan/admin/' : '/lan/'}?identityChanged=1`);
              } else if (action === 'password.change') {
                clearSession(); setNotice('passwordChanged');
                if (window.__DSH_LAN_MEMBER__) window.location.assign(`${window.__DSH_LAN_MEMBER__.adminEntry ? '/lan/admin/' : '/lan/'}?passwordChanged=1`);
              } else if (action === 'logout') {
                clearDesktopSession();
                clearSession();
              } else if (action === 'status') {
                publishBranding(result?.branding);
                if (typeof result?.initialized !== 'boolean') throw failure('INVALID_RESPONSE', t('invalidResponse'));
                setStatus(result);
              } else if (action === 'admin.checkIsolation') {
                await loadSnapshot();
                const nextStatus = await request('status'); if (mounted.current) setStatus(nextStatus);
              } else if (action === 'snapshot') {
                // loadSnapshot already published the small, authoritative reply.
              } else {
                if (action === 'admin.updateBranding') publishBranding(result?.branding);
                if (action === 'admin.createInvite') {
                  if (!result?.inviteToken) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                  setInvite({ ...result });
                }
                if (action === 'projects.create' && result?.project?.id) setSelectedId(result.project.id);
                await loadSnapshot();
                if (mounted.current) setNotice(action === 'projects.create' ? 'created' : 'saved');
              }
              return true;
            } catch (err) {
              if (mounted.current) { const message = { CURRENT_PASSWORD_INVALID: 'currentPasswordInvalid', PASSWORD_UNCHANGED: 'passwordUnchanged', AUTH_RATE_LIMIT: 'passwordRateLimit', LAST_ADMIN: 'lastAdmin', ACCOUNT_ARCHIVED: 'accountArchived', ARCHIVE_REQUIRED: 'archiveRequired', SELF_ACCOUNT: 'selfAccount', DELETE_CONFIRMATION: 'deleteConfirmation' }[err.code]; if (message) err.message = t(message); setError(err); }
              return false;
            } finally {
              // Sign out locally even if the server could not revoke its session.
              if (action === 'logout') clearSession();
              busy.current = false;
              if (mounted.current) setPending('');
            }
          }

          const accountKey = JSON.stringify([accountQuery.trim(), accountFilter, accountPage, accountPageSize]);
          const seed = snapshot?.admin?.userPage ? { ...snapshot.admin.userPage, items: snapshot.admin.users } : null;
          const seedMatches = seed && !accountQuery.trim() && accountFilter === 'all' && accountPage === 0 && accountPageSize === seed.pageSize;
          const accountValue = seedMatches ? seed : accountResult?.key === accountKey ? accountResult.value : null;
          React.useEffect(() => {
            const generation = ++accountSequence.current;
            if (user?.role !== 'admin' || !snapshot?.admin || tab !== 'admin' || adminTab !== 'accounts') return;
            if (seedMatches) { setAccountLoading(false); setAccountProblem(''); return; }
            setAccountLoading(true); setAccountProblem('');
            const timer = setTimeout(async () => {
              try {
                const value = await request('admin.listUsers', { query: accountQuery.trim(), status: accountFilter, page: accountPage, pageSize: accountPageSize });
                if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pages)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                if (mounted.current && generation === accountSequence.current) setAccountResult({ key: accountKey, value });
              } catch (error) { if (mounted.current && generation === accountSequence.current) { setAccountProblem(error.message || t('requestFailed')); setAccountResult(null); } }
              finally { if (mounted.current && generation === accountSequence.current) setAccountLoading(false); }
            }, 150);
            return () => { clearTimeout(timer); accountSequence.current++; };
          }, [user?.id, user?.role, snapshot, tab, adminTab, accountKey, seedMatches, accountRetry, request]);
          const usageKey = JSON.stringify([usageQuery.trim(), usageFilter, usagePage, usagePageSize]);
          const usageSeed = snapshot?.usage;
          const usageSeedMatches = usageSeed && !usageQuery.trim() && usageFilter === 'all' && usagePage === 0 && usagePageSize === (usageSeed.pageSize ?? 10);
          const usageValue = usageSeedMatches ? usageSeed : usageResult?.key === usageKey ? usageResult.value : null;
          React.useEffect(() => {
            const generation = ++usageSequence.current;
            if (!user || tab !== 'usage') return;
            if (usageSeedMatches) { setUsageLoading(false); setUsageProblem(''); return; }
            setUsageLoading(true); setUsageProblem('');
            const timer = setTimeout(async () => {
              try {
                const value = await request('usage.list', { query: usageQuery.trim(), status: usageFilter, page: usagePage, pageSize: usagePageSize });
                if (!Array.isArray(value.users) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pages)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
                if (generation !== usageSequence.current) return;
                setUsageResult({ key: JSON.stringify([usageQuery.trim(), usageFilter, value.page, usagePageSize]), value });
                if (value.page !== usagePage) setUsagePage(value.page);
              } catch (err) { if (generation === usageSequence.current) setUsageProblem(err.message || t('requestFailed')); }
              finally { if (generation === usageSequence.current) setUsageLoading(false); }
            }, 150);
            return () => { clearTimeout(timer); usageSequence.current++; };
          }, [user?.id, snapshot, tab, usageKey, usageSeedMatches, usageRetry, request]);
          const isBusy = Boolean(pending);
          const memberUrl = memberEntryUrl(snapshot?.memberUrl ?? status?.memberUrl) || (window.__DSH_LAN_MEMBER__ ? memberEntryUrl(new URL('/lan/', window.location.href).href) : null);
          const runtimeReady = snapshot?.capabilities?.nativeExecution ?? status?.capabilities?.nativeExecution ?? snapshot?.capabilities?.isolatedExecution ?? status?.capabilities?.isolatedExecution;
          const projects = list(snapshot?.projects);
          const routes = list(snapshot?.routes).filter(route => route.enabled === true);
          const admin = user?.role === 'admin' ? snapshot?.admin : null;
          const adminRoutes = list(admin?.modelCatalog);
          const adminUsers = list(admin?.users);
          const selected = projects.find(project => project.id === selectedId) || projects[0] || null;
          const targetUser = editorAccount || adminUsers.find(account => account.id === adminUserId) || null;
          const actionButton = (label, props = {}) => h(Button, { disabled: isBusy, ...props }, isBusy && props.type === 'submit' ? t('pending') : label);
          const form = (action, getFields, children, options = {}) => h('form', {
            id: options.id, className: 'lanw-form', 'aria-busy': isBusy, hidden: options.hidden,
            onInvalidCapture: options.onInvalid,
            onSubmit: async event => {
              event.preventDefault();
              const element = event.currentTarget;
              if (options.beforeSubmit?.(element) === false) return;
              const fields = getFields(new FormData(element));
              if (await run(action, fields, options)) {
                if (options.reset && mounted.current) element.reset();
                if (mounted.current) options.onSuccess?.();
              }
            },
          }, h('fieldset', { className: 'lanw-fieldset', disabled: isBusy }, children));
          function routeSelect(available, defaultValue, name = 'routeId', optional = false) {
            return h(Field, { label: t(optional ? 'defaultRoute' : 'route') }, h('select', { name, defaultValue: defaultValue || '', required: !optional },
              h('option', { value: '' }, t(optional ? 'noDefault' : 'chooseRoute')),
              available.map(route => h('option', { key: route.id, value: route.id }, route.label || route.id))));
          }
          function accessFields(account = {}, editor = false, compact = false, bulk = false) {
            const pane = (id, node) => h('section', { key: id, id: `lanw-access-${id}`, 'data-access-panel': id, hidden: editor && accountAccessTab !== id },
              bulk && h('div', { className: 'lanw-batch-scope' }, h(Check, { label: t({ models: 'batchScopeModels', capabilities: 'batchScopeCapabilities', directories: 'batchScopeDirectories' }[id]), 'data-batch-scope': id, checked: bulkScopes.includes(id), onChange: event => setBulkScopes(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id)) })),
              bulk ? h('fieldset', { className: 'lanw-fieldset', disabled: !bulkScopes.includes(id) }, node) : node);
            return h(React.Fragment, { key: grantDraftVersion },
              pane('models', h(ModelPolicy, { key: `${account.id || 'new'}:${account.modelAccess}:${list(account.routeIds).join(',')}:${account.defaultRouteId || ''}`, catalog: adminRoutes, account, panel: editor, compact })),
              pane('capabilities', h(React.Fragment, null, !editor && h('h3', null, t('accessCapabilities')), detailNotice('catalog'), h(AdministratorCapabilities, { account, catalog: admin ?? {}, pending: isBusy }), editor && !bulk && h(EffectiveAccess, { userId: account.id, revision: account.revision, request }))),
              pane('directories', h(DirectoryPolicy, { panel: editor, account })));
          }
          const accessData = data => ({ modelAccess: data.get('modelAccess'), ...(data.get('modelAccess') === 'custom' ? { routeIds: data.getAll('routeIds'), defaultRouteId: data.get('defaultRouteId') || null } : {}),
            access: { ...Object.fromEntries(['terminal', 'files', 'attachments', 'tasks', 'subagents', 'interactions'].map(key => [key, data.has(`access.${key}`)])), toolMode: ['whitelist', 'custom'].includes(data.get('toolAccess')) ? 'whitelist' : 'blacklist', tools: ['inherit', null].includes(data.get('toolAccess')) ? null : data.getAll('toolNames'),
              ...(data.has('skillsMode') ? { skills: data.get('skillsMode') === 'custom' ? data.getAll('skillNames') : null } : {}),
              ...(data.has('agentPresetsMode') ? { agentPresets: data.get('agentPresetsMode') === 'custom' ? data.getAll('agentPresetNames') : null } : {}),
              ...(data.has('permissionPresetsMode') ? { permissionPresets: data.get('permissionPresetsMode') === 'custom' ? data.getAll('permissionPresetNames') : null } : {}),
              ...(data.has('pluginsMode') ? { plugins: data.get('pluginsMode') === 'custom' ? data.getAll('pluginNames') : null } : {}),
              ...(data.has('mcpServersMode') ? { mcpServers: data.get('mcpServersMode') === 'custom' ? data.getAll('mcpServerNames') : null } : {}),
              ...(data.has('cliToolsMode') ? { cliTools: data.get('cliToolsMode') === 'custom' ? data.getAll('cliNames') : null } : {}),
              ...(data.has('sharedDirectories') ? { sharedDirectories: JSON.parse(data.get('sharedDirectories')) } : {}) } });
          const passwordField = autocomplete => h(Field, { label: t('longPassword'), name: 'password', type: 'password', required: true, minLength: 16, maxLength: 1024, autoComplete: autocomplete });
          const nameFields = () => h(React.Fragment, null,
            h(Field, { label: t('username'), name: 'username', required: true, maxLength: 64, autoComplete: 'username', autoCapitalize: 'none', spellCheck: false, 'data-modal-autofocus': true }),
            h(Field, { label: t('displayName'), name: 'displayName', required: true, maxLength: 100, autoComplete: 'nickname' }));
          const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : t('unknown');
          const date = value => {
            const parsed = value == null ? null : new Date(value);
            return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(ctx.locale.getSnapshot().active) : t('unknown');
          };

          function authView() {
            if (!status) return h('div', { className: 'lanw-auth lanw-stack' }, h('p', { role: 'status' }, t(isBusy ? 'loading' : 'requestFailed')), !isBusy && actionButton(t('retry'), { onClick: () => run('status') }));
            const mode = status.initialized ? authMode : 'bootstrap';
            const recovery = mode === 'owner.recoverAdministrator';
            return h('div', { className: 'lanw-auth' },
              status.initialized && h('div', { className: 'lanw-authswitch', 'aria-label': t('login') },
                ['login', 'redeem'].map(value => actionButton(t(value), { key: value, 'aria-pressed': mode === value, onClick: () => { setAuthMode(value); setError(null); } }))),
              h(Card, { title: t(mode) },
                mode === 'bootstrap' && h('p', { className: 'lanw-help', 'data-first-run-administrator': true }, t('setupAdminStep')),
                h('p', { className: 'lanw-help' }, t(recovery ? 'recoveryNote' : mode === 'bootstrap' ? 'setupNote' : 'invitationOnly')),
                h('div', { key: mode }, form(mode, data => {
                  if (recovery) return { username: data.get('username'), password: data.get('password') };
                  const fields = { username: data.get('username'), password: data.get('password'), remember: data.has('remember') };
                  if (mode !== 'login') fields.displayName = data.get('displayName');
                  if (mode === 'redeem') fields.inviteToken = data.get('inviteToken');
                  return fields;
                }, h(React.Fragment, null,
                  mode === 'redeem' && h(Field, { label: t('inviteToken'), name: 'inviteToken', required: true, autoComplete: 'off', spellCheck: false, maxLength: 512 }),
                  mode === 'login' || recovery ? h(Field, { label: t('username'), name: 'username', required: true, autoComplete: 'username', defaultValue: rememberedUsername(), maxLength: 64, autoCapitalize: 'none', spellCheck: false }) : nameFields(),
                  mode === 'login' ? h(Field, { label: t('password'), name: 'password', type: 'password', required: true, autoComplete: 'current-password', maxLength: 1024 }) : passwordField('new-password'),
                  !recovery && h(Check, { label: t('rememberLogin'), name: 'remember', checked: remember, onChange: event => { setRemember(event.target.checked); if (!event.target.checked) rememberUsername('', false); } }),
                  recovery && h(Check, { label: t('recoveryConsent'), name: 'confirmRecovery', required: true }),
                  mode === 'bootstrap' && h(Check, { label: t('setupConsent'), name: 'confirmOwner', required: true }),
                  actionButton(t(mode), { type: 'submit', primary: true })), { ownerSetup: mode === 'bootstrap' || recovery, reset: true })),
                !window.__DSH_LAN_MEMBER__ && !desktopWindow && status.initialized && !recovery && actionButton(t('owner.recoverAdministrator'), { onClick: () => { setAuthMode('owner.recoverAdministrator'); setError(null); }, 'data-recover-administrator': true }),
                h('p', { className: 'lanw-help', style: { marginTop: 14 } }, t('memoryOnly'))));
          }

          function limitsUsage(value = {}) {
            const compact = n => Number.isFinite(n) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : t('unknown');
            const tokenValue = bucket => {
              const row = value.usage?.[bucket], incomplete = row?.unknownCalls || row?.unavailableSessions || value.usage?.undatedCalls;
              return row ? `${incomplete ? '≥ ' : ''}${compact(row.totalTokens)}` : t('unknown');
            };
            return h('dl', { className: 'lanw-dl lanw-sharing-summary', 'data-limits-usage': true },
              [['limitsActive', `${value.active ?? 0} / ${value.maxConcurrent ?? t('unlimited')}`], ['limitsDayUsed', `${tokenValue('daily')} / ${value.dailyTokens == null ? t('unlimited') : compact(value.dailyTokens)}`], ['limitsMonthUsed', `${tokenValue('monthly')} / ${value.monthlyTokens == null ? t('unlimited') : compact(value.monthlyTokens)}`]].map(([key, text]) => h(React.Fragment, { key }, h('dt', null, t(key)), h('dd', null, text))));
          }

          function workspaceView() {
            // A member sees its own projects in the sidebar; the host-side home
            // allocation and the member-entry address are owner concerns and are
            // not shown on the member page.
            const member = Boolean(window.__DSH_LAN_MEMBER__);
            return h('section', { className: 'lanw-stack', 'data-workspace-access': true },
              member ? null : h(UserHome, { value: snapshot?.home }),
              snapshot?.limits && h(Card, { title: t('limitsOwn') }, limitsUsage(snapshot.limits)),
              member ? null : memberUrl ? h('a', { className: 'lanw-btn', 'data-member-entry': true, href: memberUrl, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, t('enterMember')) : h('p', { className: 'lanw-help', role: 'status' }, t('memberEntryMissing')));
          }

          function usageView() {
            const usage = usageValue;
            const rows = list(usage?.users);
            const pages = usage?.pages ?? 1, page = usage?.page ?? 0;
          return h(Card, { className: 'lanw-usage', 'aria-busy': usageLoading },
              h('div', { className: 'lanw-toolbar' }, h(Field, { label: t('searchAccounts') }, h('input', { type: 'search', 'data-usage-search': true, placeholder: t('searchAccounts'), value: usageQuery, onChange: event => { setUsageQuery(event.target.value); setUsagePage(0); } }))),
              h('div', { className: 'lanw-account-filters' }, h('span', { className: 'lanw-help' }, usage ? `${usage.total ?? rows.length} ${t('accountRows')}` : t(usageProblem ? 'requestFailed' : 'loading')), h('div', { className: 'lanw-row', 'aria-label': t('accountStatus') }, ['all', 'enabled', 'disabled'].map(value => h(Button, { key: value, 'data-usage-filter': value, 'aria-pressed': usageFilter === value, onClick: () => { setUsageFilter(value); setUsagePage(0); } }, t(`filter${value[0].toUpperCase()}${value.slice(1)}`))))),
              usageProblem && h('div', { role: 'alert', className: 'lanw-notice lanw-error' }, h('p', null, usageProblem), h(Button, { onClick: () => setUsageRetry(value => value + 1) }, t('retry'))),
              usage?.unknown === true && h('p', { className: 'lanw-help', role: 'status' }, t('usageUnknown')),
              rows.length ? h('div', { className: 'lanw-tablewrap' }, h('table', null,
                h('caption', null, t('allTime')),
                h('thead', null, h('tr', null, ['displayName', 'calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls'].map(key => h('th', { key, scope: 'col' }, t(key))))),
                h('tbody', null, rows.map((row, index) => h('tr', { key: index },
                  h('th', { scope: 'row' }, row.displayName || t('unknown')),
                  ['calls', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownCalls'].map(key => {
                    const lowerBound = row[key] !== null && (row.incomplete && ['inputTokens', 'outputTokens', 'totalTokens'].includes(key) || row.unavailableSessions > 0 && ['calls', 'unknownCalls'].includes(key)) ? '≥ ' : '';
                    return h('td', { key, 'aria-label': `${lowerBound}${number(row[key])}` }, `${lowerBound}${Number.isFinite(row[key]) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(row[key]) : t('unknown')}`);
                  }))))))
                : h('p', { className: 'lanw-empty', role: 'status' }, t(!usage ? usageProblem ? 'requestFailed' : 'loading' : usageQuery.trim() || usageFilter !== 'all' ? 'noAccountMatches' : 'usageEmpty')),
              h('div', { className: 'lanw-account-pagination', 'data-usage-pagination': true }, h('label', { className: 'lanw-model-size' }, h('span', null, t('accountPageSize')), h('select', { 'data-usage-page-size': true, 'aria-label': t('accountPageSize'), value: usagePageSize, onChange: event => { setUsagePageSize(Number(event.target.value)); setUsagePage(0); } }, [10, 20, 50].map(size => h('option', { value: size, key: size }, size)))), h(Pager, { page, pages, setPage: setUsagePage, disabled: usageLoading || isBusy })));
          }

          function accountEditor() {
            if (accountPanel === 'bulk') {
              const members = bulkTicket?.items ?? Object.values(bulkSelection).filter(member => member.username).slice(0, 50), count = bulkTicket?.count ?? Object.keys(bulkSelection).length, draft = editorAccount;
              const close = () => { batchSelectionSequence.current++; setBatchSelecting(false); setAccountPanel(''); setEditorAccount(null); setBulkScopes([]); setBulkTicket(null); setError(null); };
              const sections = [['models', 'accessModels'], ['capabilities', 'accessCapabilities'], ['directories', 'accessDirectories']].map(([id, label]) => ({ id, label: t(label), description: t(`${label}Note`) }));
              return h(EditDialog, { title: t('batchAccess'), subtitle: `${count} ${t('batchSelected')}`, className: 'lanw-authorization-dialog', sections, activeSection: accountAccessTab, onSelect: setAccountAccessTab, editorKind: 'bulk', draftRevision: grantDraftVersion, pending: isBusy, onClose: close,
                footer: actionButton(`${t('batchApply')} (${count})`, { primary: true, type: 'submit', form: 'lanw-batch-access-form', disabled: isBusy || batchSelecting || !bulkTicket || !draft || !count || !bulkScopes.length || bulkScopes.includes('capabilities') && !Array.isArray(admin?.toolCatalog) }) },
                h('details', { className: 'lanw-batch-selection', 'data-batch-recipients': true }, h('summary', null, `${t('batchMembers')} (${count})`), h('div', { className: 'lanw-batch-recipients' }, members.map(member => h('span', { key: member.id, className: 'lanw-badge' }, `${member.displayName || member.username} · @${member.username}`)), count > members.length && h('span', { className: 'lanw-help' }, `+ ${count - members.length} ${t('batchMore')}`))),
                h('p', { className: 'lanw-help' }, t('batchNote')),
                error && h('div', { className: 'lanw-notice lanw-error', role: 'alert' }, h('p', null, error.code === 'ACCOUNT_CONFLICT' ? t('batchConflict') : error.message || t('requestFailed')),
                  ['ACCOUNT_CONFLICT', 'ACCOUNT_ARCHIVED', 'USER_NOT_FOUND', 'BATCH_SELECTION_EXPIRED'].includes(error.code) && actionButton(t('batchReselect'), { onClick: () => { close(); setBulkSelection({}); setAccountRetry(value => value + 1); } })),
                draft ? h(React.Fragment, null,
                  h('details', { className: 'lanw-batch-template' }, h('summary', null, `${t('batchTemplate')} ${draft.displayName || draft.username}`), h(GrantCopy, { users: adminUsers, userPage: admin?.userPage, request, compact: true, disabled: isBusy, onCopy: source => { setEditorAccount(source); setGrantDraftVersion(value => value + 1); } })),
                  form('admin.batchUpdateAccess', data => {
                    const grants = accessData(data), fields = { selectionId: bulkTicket.selectionId };
                    if (bulkScopes.includes('models')) Object.assign(fields, Object.fromEntries(['modelAccess', 'routeIds', 'defaultRouteId'].filter(key => Object.hasOwn(grants, key)).map(key => [key, grants[key]])));
                    if (bulkScopes.includes('capabilities')) fields.access = Object.fromEntries(Object.entries(grants.access).filter(([key]) => key !== 'sharedDirectories'));
                    if (bulkScopes.includes('directories')) fields.access = { ...fields.access, sharedDirectories: grants.access.sharedDirectories ?? [] };
                    return fields;
                  }, accessFields(draft, true, false, true), { id: 'lanw-batch-access-form', beforeSubmit: () => Boolean(bulkTicket && bulkScopes.length), onSuccess: () => { setBulkSelection({}); close(); } }))
                  : h('p', { className: 'lanw-help', role: 'status' }, t(isBusy || batchSelecting ? 'loading' : 'requestFailed')));
            }
            if (!accountPanel || accountPanel === 'edit' && !targetUser) return null;
            const title = accountPanel === 'create' ? t('createUser') : accountPanel === 'invite' ? t('createInvite') : targetUser.displayName || targetUser.username;
            const close = () => { setAccountPanel(''); setAdminUserId(''); setEditorAccount(null); setInvite(null); setAccountAccessTab('models'); setAccountSetupStep(0); };
            const sections = [['models', 'accessModels'], ['capabilities', 'accessCapabilities'], ['limits', 'accessLimits'], ['directories', 'accessDirectories'], ['status', 'accessStatus'], ['security', 'accessSecurity']].map(([id, label]) => ({ id, label: t(label), description: t(`${label}Note`), group: ['models', 'capabilities', 'limits'].includes(id) ? 'accessGroupBase' : 'accessGroupAccount' }));
            const editing = accountPanel === 'edit', creating = accountPanel === 'create', finished = accountPanel === 'invite' && Boolean(invite);
            const grantCopy = () => h(GrantCopy, { users: adminUsers, userPage: admin?.userPage, exclude: editing ? targetUser.id : '', request, disabled: isBusy, onCopy: source => {
              if (!source?.access || !Array.isArray(source.routeIds)) throw failure('INVALID_RESPONSE', t('invalidResponse'));
              const grants = JSON.parse(JSON.stringify(Object.fromEntries(['modelAccess', 'routeIds', 'defaultRouteId', 'access'].map(key => [key, source[key]]))));
              if (editing) setEditorAccount({ ...targetUser, ...grants }); else setGrantTemplate(grants);
              setGrantDraftVersion(value => value + 1);
            } });
            const setupProgress = !editing && h('ol', { className: 'lanw-setup-progress', 'aria-label': t(creating ? 'accountSetupProgress' : 'inviteSetupProgress') }, [creating ? 'accountSetupInfo' : 'inviteSetupInfo', 'accountSetupPermissions'].map((label, index) =>
              h('li', { key: label, id: `lanw-account-step-title-${index}`, 'aria-current': !finished && accountSetupStep === index ? 'step' : undefined, 'data-complete': finished || index < accountSetupStep }, h('span', { className: 'lanw-setup-number', 'aria-hidden': true }, index + 1), h('span', null, t(label)))));
            const setupOptions = {
              beforeSubmit: () => { if (accountSetupStep === 0) { setAccountSetupStep(1); return false; } return !finished; },
              onInvalid: event => {
                const input = event.target, step = Number(input.closest('[data-account-step]')?.dataset.accountStep);
                if (![0, 1].includes(step) || step === accountSetupStep) return;
                event.preventDefault(); setAccountSetupStep(step); requestAnimationFrame(() => input.reportValidity());
              },
            };
            return h(EditDialog, { title: editing ? t('accountAuthorization') : title,
              ...(editing ? { className: 'lanw-authorization-dialog', subtitle: `${title} · @${targetUser.username} · ${t(targetUser.role === 'admin' ? 'adminRole' : 'memberRole')}`, sections, activeSection: accountAccessTab, onSelect: setAccountAccessTab } : { className: `lanw-create-dialog lanw-account-wizard${accountSetupStep === 1 ? ' lanw-permission-step' : ''}` }),
              progress: setupProgress, setupStep: !editing && !finished ? accountSetupStep : undefined, hideCancel: finished,
              editorKind: accountPanel, resetKey: invite, draftRevision: grantDraftVersion, pending: isBusy, onClose: close, key: `${accountPanel}:${adminUserId}:${targetUser?.revision ?? 0}`,
              footer: editing ? accountAccessTab === 'security'
                ? actionButton(t('resetPassword'), { type: 'submit', form: 'lanw-reset-password-form', className: 'lanw-btn-danger' })
                : actionButton(t(accountAccessTab === 'limits' ? 'saveLimits' : 'saveAccess'), { type: 'submit', form: accountAccessTab === 'limits' ? 'lanw-account-limits-form' : 'lanw-account-access-form', primary: true })
                : finished ? actionButton(t('accountSetupDone'), { primary: true, onClick: close })
                  : h(React.Fragment, null, accountSetupStep === 1 && actionButton(t('accountSetupBack'), { 'data-account-previous': true, onClick: () => setAccountSetupStep(0) }), actionButton(t(accountSetupStep === 0 ? 'accountSetupNext' : creating ? 'createUser' : 'createInvite'), { type: 'submit', form: `lanw-account-${accountPanel}-form`, primary: true, 'data-account-next': accountSetupStep === 0 ? true : undefined })) },
              !editing && error && h('div', { className: 'lanw-notice lanw-error', role: 'alert' }, h('strong', null, error.code || 'REQUEST_FAILED'), h('p', null, error.message || t('requestFailed'))),
              accountPanel === 'create' && form('admin.createUser', data => ({ username: data.get('username'), displayName: data.get('displayName'), password: data.get('password'), ...accessData(data) }), h(React.Fragment, null,
                h('section', { className: 'lanw-stack lanw-account-step lanw-account-identity', 'data-account-step': 0, 'aria-labelledby': 'lanw-account-step-title-0', hidden: accountSetupStep !== 0 }, h('p', { className: 'lanw-help' }, t('accountSetupInfoNote')), h('div', { className: 'lanw-identity-fields' }, nameFields(), passwordField('new-password'))),
                h('section', { className: 'lanw-stack lanw-account-step', 'data-account-step': 1, 'aria-labelledby': 'lanw-account-step-title-1', hidden: accountSetupStep !== 1 }, h('p', { className: 'lanw-help' }, t('accountSetupPermissionsNote')), grantCopy(), accessFields(grantTemplate || { access: { sharedDirectories: admin?.setup?.sharedDirectories ?? [] } }, false, true))), { ...setupOptions, id: 'lanw-account-create-form', reset: true, onSuccess: close }),
              accountPanel === 'invite' && h('div', { className: 'lanw-stack' },
                form('admin.createInvite', data => ({ displayName: data.get('displayName') || undefined, ...accessData(data) }), h(React.Fragment, null,
                  h('section', { className: 'lanw-stack lanw-account-step lanw-account-identity', 'data-account-step': 0, 'aria-labelledby': 'lanw-account-step-title-0', hidden: accountSetupStep !== 0 }, h('p', { className: 'lanw-help' }, t('inviteSetupInfoNote')), h('div', { className: 'lanw-identity-fields' }, h(Field, { label: t('optionalName'), name: 'displayName', maxLength: 100, 'data-modal-autofocus': true }))),
                  h('section', { className: 'lanw-stack lanw-account-step', 'data-account-step': 1, 'aria-labelledby': 'lanw-account-step-title-1', hidden: accountSetupStep !== 1 }, h('p', { className: 'lanw-help' }, t('inviteSetupPermissionsNote')), grantCopy(), accessFields(grantTemplate || { access: { sharedDirectories: admin?.setup?.sharedDirectories ?? [] } }, false, true))), { ...setupOptions, id: 'lanw-account-invite-form', reset: true, hidden: finished }),
                invite && h('div', { className: 'lanw-card lanw-invite lanw-stack', 'data-invite-result': true }, h('h3', null, t('inviteReady')), h('p', { className: 'lanw-help' }, t('inviteOnce')),
                  h(InviteLink, { memberUrl, inviteToken: invite.inviteToken }),
                  h('p', { className: 'lanw-help' }, `${t('expiresAt')}: ${date(invite.expiresAt)}`))),
              accountPanel === 'edit' && targetUser && h('div', { className: 'lanw-stack', key: `${targetUser.id}:${targetUser.revision ?? 0}` },
                error && h('div', { className: 'lanw-notice lanw-error', role: 'alert' }, h('strong', null, error.code || 'REQUEST_FAILED'), h('p', null, error.code === 'ACCOUNT_CONFLICT' ? t('accountConflict') : error.message || t('requestFailed')),
                  error.code === 'ACCOUNT_CONFLICT' && actionButton(t('reloadAccount'), { onClick: () => run('admin.getUser', { userId: adminUserId }) })),
                form('admin.updateUser', data => ({ userId: targetUser.id, expectedRevision: targetUser.revision ?? 0, ...(data.has('displayName') ? { displayName: data.get('displayName') } : {}), ...(data.has('role') ? { role: data.get('role') } : {}), disabled: data.has('disabled'), ...accessData(data) }), h(React.Fragment, null,
                  h('div', { hidden: !['models', 'capabilities', 'directories'].includes(accountAccessTab) }, grantCopy()),
                  accessFields(targetUser, true), h('section', { id: 'lanw-access-status', 'data-access-panel': 'status', hidden: accountAccessTab !== 'status', className: 'lanw-policy-pane' },
                    h(Field, { label: t('displayName'), name: 'displayName', required: true, maxLength: 80, defaultValue: targetUser.displayName }),
                    h(Field, { label: t('accountRole') }, h('select', { name: 'role', defaultValue: targetUser.role }, ['member', 'admin'].map(role => h('option', { value: role, key: role }, t(role === 'admin' ? 'adminRole' : 'memberRole'))))),
                    h('p', { className: 'lanw-help' }, t('roleNote')), h(Check, { label: t('disabled'), name: 'disabled', defaultChecked: targetUser.disabled === true }), h('p', { className: 'lanw-help' }, t('accountNote')))), { id: 'lanw-account-access-form', hidden: ['limits', 'security'].includes(accountAccessTab), onSuccess: close }),
                h('section', { id: 'lanw-access-limits', 'data-access-panel': 'limits', hidden: accountAccessTab !== 'limits', className: 'lanw-policy-pane' }, detailNotice('usage'), h('p', { className: 'lanw-help' }, t('limitsNote')), limitsUsage(targetUser.limits),
                  form('admin.updateLimits', data => ({ userId: targetUser.id, expectedRevision: targetUser.limits?.revision ?? 0, ...Object.fromEntries(['maxConcurrent', 'dailyTokens', 'monthlyTokens'].map(key => [key, data.get(key) === '' ? null : Number(data.get(key))])) }),
                    h('div', { className: 'lanw-stack' }, ['maxConcurrent', 'dailyTokens', 'monthlyTokens'].map(key => h(Field, { key, label: t(key), description: t(`${key}Note`) }, h('input', { name: key, type: 'number', min: 0, step: 1, placeholder: t('unlimited'), defaultValue: targetUser.limits?.[key] ?? '', 'data-limit-field': key }))),
                      h('p', { className: 'lanw-help' }, t('limitsUnknown'))), { id: 'lanw-account-limits-form' })),
                h('section', { id: 'lanw-access-security', 'data-access-panel': 'security', hidden: accountAccessTab !== 'security', className: 'lanw-policy-pane lanw-danger', 'data-password-danger': true },
                  h('div', null, form('admin.resetPassword', data => ({ userId: targetUser.id, password: data.get('password') }), h(React.Fragment, null,
                    passwordField('new-password'), h(Check, { label: t('resetConsent'), required: true, name: 'confirmReset' })), { id: 'lanw-reset-password-form', reset: true })))));
          }

          function accountsView() {
            const query = accountQuery.trim().toLowerCase();
            const visible = accountValue?.items ?? [], pages = accountValue?.pages ?? 1, page = accountValue?.page ?? 0;
            const chosen = Object.values(bulkSelection), eligible = visible.filter(account => account.archivedAt == null);
            const pageSelected = chosen.length > 0 && chosen.length === accountValue?.total;
            const selectAccount = account => setBulkSelection(previous => {
              const next = { ...previous };
              if (next[account.id]) delete next[account.id];
              else next[account.id] = account;
              return next;
            });
            const selectPage = async () => {
              if (pageSelected) { batchSelectionSequence.current++; setBulkSelection({}); setBatchSelecting(false); return; }
              const generation = ++batchSelectionSequence.current; setBatchSelecting(true); setError(null);
              try {
                const selection = await request('admin.prepareBatchAccess', { query: accountQuery.trim(), status: accountFilter, capture: false });
                if (mounted.current && generation === batchSelectionSequence.current) {
                  const names = new Map(selection.items.map(member => [member.id, member]));
                  setBulkSelection(Object.fromEntries(selection.userIds.map(id => [id, names.get(id) ?? { id }])));
                }
              } catch (error) { if (mounted.current && generation === batchSelectionSequence.current) setError(error); }
              finally { if (mounted.current && generation === batchSelectionSequence.current) setBatchSelecting(false); }
            };
            const openBatch = async () => {
              const generation = ++batchSelectionSequence.current; setBatchSelecting(true); setAccountPanel('bulk'); setAdminUserId(''); setEditorAccount(null); setBulkTicket(null); setBulkScopes([]); setGrantDraftVersion(0); setAccountAccessTab('models'); setError(null);
              try {
                const selection = await request('admin.prepareBatchAccess', { userIds: chosen.map(member => member.id) });
                if (mounted.current && generation === batchSelectionSequence.current) { setBulkTicket(selection); setEditorAccount(selection.source); }
              } catch (error) { if (mounted.current && generation === batchSelectionSequence.current) setError(error); }
              finally { if (mounted.current && generation === batchSelectionSequence.current) setBatchSelecting(false); }
            };
            const chooseOperation = (kind, account) => { setError(null); setAccountOperation({ kind, account }); };
            const accountActions = account => h(AccountActions, { account, enabled: snapshot?.capabilities?.accountLifecycle === true, currentUserId: user.id, disabled: isBusy || accountLoading, onEdit: () => openPanel('edit', account.id), onOperation: kind => chooseOperation(kind, account) });
            function openPanel(mode, id = '') { if (mode === 'edit' && accountLoading) return; setAccountPanel(mode); setAdminUserId(id); setEditorAccount(visible.find(row => row.id === id) || null); setGrantTemplate(null); setGrantDraftVersion(0); setInvite(null); setError(null); setAccountAccessTab('models'); setAccountSetupStep(0); }
            return h('div', { className: 'lanw-stack', 'aria-busy': accountLoading },
              h('div', { className: 'lanw-toolbar' },
                h(Field, { label: t('searchAccounts') }, h('input', { type: 'search', 'data-account-search': true, placeholder: t('searchAccounts'), value: accountQuery, onChange: event => { setAccountQuery(event.target.value); setAccountPage(0); } })),
                h('div', { className: 'lanw-row' }, actionButton(t('inviteAccount'), { 'data-account-action': 'invite', onClick: () => openPanel('invite') }), actionButton(t('newAccount'), { primary: true, 'data-account-action': 'create', onClick: () => openPanel('create') }))),
              h('div', { className: 'lanw-account-filters' }, h('span', { className: 'lanw-help' }, accountValue ? `${accountValue.total} ${t('accountRows')}` : t(accountProblem ? 'requestFailed' : 'loading')), h('div', { className: 'lanw-row', 'aria-label': t('accountStatus') }, ['all', 'enabled', 'disabled', ...(snapshot?.capabilities?.accountLifecycle ? ['archived'] : [])].map(value => actionButton(t(`filter${value[0].toUpperCase()}${value.slice(1)}`), { key: value, 'data-account-filter': value, 'aria-pressed': accountFilter === value, onClick: () => { setAccountFilter(value); setAccountPage(0); } })))),
              (chosen.length > 0 || batchSelecting) && h('div', { className: 'lanw-batchbar', 'data-batch-toolbar': true },
                h('span', { role: 'status' }, batchSelecting ? t('batchSelecting') : `${chosen.length} ${t('batchSelected')}`),
                actionButton(t('batchAccess'), { primary: true, 'data-batch-open': true, disabled: isBusy || batchSelecting || !chosen.length, onClick: openBatch }),
                actionButton(t('batchClear'), { onClick: () => { batchSelectionSequence.current++; setBatchSelecting(false); setBulkSelection({}); } }), h('small', { className: 'lanw-help' }, t('batchLimit'))),
              accountProblem && h('div', { role: 'alert', className: 'lanw-notice lanw-error' }, h('p', null, accountProblem), actionButton(t('retry'), { onClick: () => setAccountRetry(value => value + 1) })),
              h('div', { className: 'lanw-accountlayout' },
                h('section', { className: 'lanw-accountlist', 'aria-label': t('accountsTab') },
                  visible.length ? h('div', { className: 'lanw-tablewrap' }, h('table', { className: 'lanw-account-table' },
                    h('thead', null, h('tr', null, h('th', { className: 'lanw-selection-cell', scope: 'col' }, h('input', { type: 'checkbox', 'data-batch-page': true, 'aria-label': t('batchPage'), checked: pageSelected, ref: input => { if (input) input.indeterminate = !pageSelected && chosen.length > 0; }, disabled: isBusy || batchSelecting || accountLoading || !eligible.length, onChange: selectPage })), ['displayName', 'accountRole', 'accountStatus', 'accountVariants', 'accountActions'].map(key => h('th', { key, scope: 'col' }, t(key))))),
                    h('tbody', null, visible.map(account => h('tr', { key: account.id, 'data-account-row': account.id, 'aria-selected': Boolean(bulkSelection[account.id]), tabIndex: account.archivedAt == null ? 0 : -1, onClick: event => { if (account.archivedAt == null && !event.target.closest('button,input,label')) openPanel('edit', account.id); }, onKeyDown: event => { if (account.archivedAt == null && event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openPanel('edit', account.id); } } },
                      h('td', { className: 'lanw-selection-cell' }, h('input', { type: 'checkbox', 'data-batch-select': account.id, 'aria-label': `${t('batchSelect')} ${account.displayName || account.username}`, checked: Boolean(bulkSelection[account.id]), disabled: isBusy || batchSelecting || accountLoading || account.archivedAt != null, onChange: () => selectAccount(account) })),
                      h('td', null, h('div', { className: 'lanw-accountname' }, h('span', { className: 'lanw-account-displayname' }, account.displayName || account.username), h('small', null, `@${account.username}`))),
                      h('td', null, h('span', { className: 'lanw-badge' }, t(account.role === 'admin' ? 'adminRole' : 'memberRole'))),
                      h('td', null, h('span', { className: `lanw-status${account.disabled ? ' is-disabled' : ''}` }, t(account.archivedAt != null ? 'archivedAccount' : account.disabled ? 'disabledState' : 'active'))),
                      h('td', null, h('span', { className: 'lanw-access-summary' }, account.modelAccess === 'inherit' || account.modelAccess === undefined && !list(account.routeIds).length ? t('inheritSummary') : `${t('customSummary')} · ${list(account.routeIds).length}`)),
                      h('td', null, accountActions(account)))))))
                    : h('p', { className: 'lanw-empty', role: 'status' }, t(!accountValue ? accountProblem ? 'requestFailed' : 'loading' : query ? 'noAccountMatches' : accountFilter === 'archived' ? 'noArchivedAccounts' : 'noUsers'))),
                accountEditor(),
                accountOperation && h(AccountOperationDialog, { key: `${accountOperation.kind}:${accountOperation.account.id}`, operation: accountOperation, pending: isBusy, error, onClose: () => { setAccountOperation(null); setError(null); }, onConfirm: async confirmation => {
                  const { kind, account } = accountOperation;
                  const ok = await run(`admin.${kind}User`, { userId: account.id, expectedRevision: account.revision ?? 0, ...(kind === 'delete' ? { confirmUsername: confirmation } : {}) });
                  if (ok) setAccountOperation(null);
                } })),
              h('div', { className: 'lanw-account-pagination', 'data-account-pagination': true }, h('label', { className: 'lanw-model-size' }, h('span', null, t('accountPageSize')), h('select', { value: accountPageSize, 'aria-label': t('accountPageSize'), onChange: event => { setAccountPageSize(Number(event.target.value)); setAccountPage(0); } }, [5, 10, 20, 50].map(size => h('option', { value: size, key: size }, size)))), h(Pager, { page, pages, setPage: setAccountPage, disabled: accountLoading || isBusy })),
              h(InvitationManager, { request, disabled: isBusy, refreshKey: invite?.inviteToken, onIssued: result => { setInvite(result); setAccountPanel('invite'); setAccountSetupStep(1); setError(null); } }));
          }

          function sharingView() {
            const tabs = [['resources', 'sharingResourcesTab'], ['execution', 'executionToolCatalog'], ['directory', 'homeDirectory']];
            return h('div', { className: 'lanw-stack', 'data-sharing-workspace': true },
              h('div', { className: 'lanw-execution-tabs lanw-sharing-tabs', role: 'tablist', 'aria-label': t('sharingTab'), onKeyDown: event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); const index = tabs.findIndex(([id]) => id === sharingTab);
                const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length][0];
                setSharingTab(next); event.currentTarget.querySelector(`[data-sharing-tab="${next}"]`)?.focus();
              } }, tabs.map(([id, label]) => h(Button, { key: id, id: `lanw-sharing-tab-${id}`, role: 'tab', 'data-sharing-tab': id, 'aria-selected': sharingTab === id, 'aria-controls': `lanw-sharing-panel-${id}`, tabIndex: sharingTab === id ? 0 : -1, onClick: () => setSharingTab(id) }, t(label)))),
              tabs.map(([id]) => h('section', { key: id, id: `lanw-sharing-panel-${id}`, className: 'lanw-sharing-panel', role: 'tabpanel', 'aria-labelledby': `lanw-sharing-tab-${id}`, hidden: sharingTab !== id },
                id === 'resources' ? h(Card, { 'data-native-sharing': true },
                  h('p', { className: 'lanw-help' }, t('nativeSharingNote')), detailNotice('catalog'),
                  h('dl', { className: 'lanw-dl lanw-sharing-summary' }, [
                    [t('pluginAccess'), list(admin.pluginCatalog).length], [t('toolAccess'), list(admin.toolCatalog).length],
                    [t('skillAccess'), list(admin.skillCatalog).length], [t('agentPresetAccess'), list(admin.agentPresetCatalog).length], [t('mcpAccess'), list(admin.mcpCatalog).length],
                  ].map(([label, count]) => h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, detailState.catalog?.ready ? number(count) : '—')))),
                  actionButton(t('manageAccountAccess'), { className: 'lanw-btn-secondary', onClick: () => setAdminTab('accounts') }))
                  : id === 'execution' ? h(SharedExecutionTools, { active: sharingTab === 'execution' && adminTab === 'sharing' && tab === 'admin', request, disabled: isBusy, onSaved: () => ensureDetails('catalog', true) })
                  : h(HomeDirectory, { value: admin.homeDirectory, disabled: isBusy, onSave: fields => run('admin.updateHomeDirectory', fields), onReload: async () => (await loadSnapshot()).admin?.homeDirectory }))));
          }

          function adminView() {
            if (!admin) return h('p', { className: 'lanw-empty', role: 'status' }, t(isBusy ? 'loading' : 'noAdmin'));
            return h('div', { className: 'lanw-stack', 'data-admin-console': true },
              ['accounts', 'content', 'models', 'sharing', 'branding'].filter(value => visitedAdminTabs[value]).map(value => h('section', {
                key: value, className: 'lanw-adminpanel', id: `lanw-panel-${value === 'content' ? contentMode : value}`, 'aria-labelledby': `lanw-tab-${value === 'content' ? contentMode : value}`, hidden: adminTab !== value, 'data-admin-section': value,
              }, value === 'accounts' ? accountsView() : value === 'content' ? h(ContentManager, { pageMode: contentMode, onModeChange: setContentMode, users: adminUsers, userPage: admin?.userPage, historicalAccounts: snapshot?.capabilities?.accountLifecycle === true, request, active: adminTab === 'content' && tab === 'admin', closeSettings: close, administratorId: user.id, returnPoint: previewReturn?.administratorId === user.id ? previewReturn : null, capturePreviewRelease: () => { const session = { ...auth.current }; return previewId => request('admin.content', { operation: 'preview.close', previewId }, false, '', session); } }) : value === 'models' ? h(ModelCatalog, { catalog: adminRoutes, initiallyOpen: true }) : value === 'branding' ? h(BrandingEditor, { value: snapshot.branding ?? branding, disabled: isBusy, onSave: fields => run('admin.updateBranding', fields), onReload: async () => { setError(null); return (await loadSnapshot()).branding; } }) : sharingView())));
          }

          const activeTab = user !== null && user.role !== 'admin' && tab === 'admin' ? 'account' : tab;
          const activePage = activeTab === 'admin' ? adminTab : activeTab;
          const currentPage = activePage === 'content' ? contentMode : activePage;
          const needsCatalog = currentPage === 'preferences' || currentPage === 'sharing' && sharingTab === 'resources' || currentPage === 'accounts' && (['create', 'invite'].includes(accountPanel) || ['edit', 'bulk'].includes(accountPanel) && accountAccessTab === 'capabilities');
          const needsUsage = ['account', 'usage'].includes(currentPage) || currentPage === 'accounts' && accountPanel === 'edit' && accountAccessTab === 'limits';
          React.useEffect(() => {
            if (!snapshot || pending) return;
            if (needsCatalog) void ensureDetails('catalog');
            if (needsUsage) void ensureDetails('usage');
          }, [snapshot, pending, needsCatalog, needsUsage, ensureDetails]);
          const pageLabels = { account: 'workspaceAccount', preferences: 'personalTab', accounts: 'memberAccounts', sessions: 'contentSessions', files: 'contentFiles', models: 'sharedModels', sharing: 'sharingTab', branding: 'brandingTab', usage: 'usageStatistics' };
          const navigationGroups = [
            ['personal', 'navigationPersonal', ['account', 'preferences', ...(user?.role === 'admin' ? [] : ['usage'])]],
            ['workspace', 'navigationWorkspace', ['sessions', 'files']],
            ...(user?.role === 'admin' ? [['management', 'navigationManagement', ['accounts', 'models', 'sharing', 'branding', 'usage']]] : []),
          ];
          const ownFilesDisabled = user?.role !== 'admin' && snapshot?.preferences?.effective?.files === false;
          const selectPage = value => {
            if (['sessions', 'files'].includes(value)) { if (value === 'files' && ownFilesDisabled) return; setContentMode(value); value = 'content'; }
            if (['account', 'preferences', 'usage'].includes(value) || value === 'content' && user?.role !== 'admin') setTab(value);
            else { setTab('admin'); setAdminTab(value); setVisitedAdminTabs(old => ({ ...old, [value]: true })); }
          };
          const workspaceActions = h('div', { className: 'lanw-sidebar-actions' }, h(WorkspaceInfo, { runtimeReady, memberUrl, isolation: admin?.isolationCheck, onCheck: admin ? () => run('admin.checkIsolation') : null, pending }),
            actionButton(h(IconRefreshOutlineRegular, { size: 16 }), { className: 'lanw-iconbutton', 'data-refresh-account': true, 'aria-label': t('refresh'), 'aria-busy': isBusy, title: t('refresh'), onClick: async () => { if (window.__DSH_LAN_MEMBER__) await run('snapshot'); else if (await run('status') && user) await run('snapshot'); } }));
          if (user?.role === 'admin' && admin?.setup?.required) return h('div', { className: 'lanw lanw-setup-shell', 'aria-busy': isBusy }, h('style', null, styles), h(SetupGuide, { key: `${admin.setup.revision}:${admin.homeDirectory?.revision}`, value: admin.setup, home: admin.homeDirectory ?? {}, pending: isBusy, error, onComplete: fields => run('admin.completeSetup', fields), onReload: () => run('snapshot') }));
          if (fileAction) return h('div', { className: 'lanw' }, user && !pending ? h(SidebarFileOperation, { command: fileAction, request, close }) : h(EditDialog, { title: t('contentManage'), pending: Boolean(pending), onClose: close, confirmChanges: false, className: 'lanw-content-action-dialog' }, h('p', { role: error ? 'alert' : 'status' }, error?.message || t(pending ? 'loading' : 'expired'))));
          if (!window.__DSH_LAN_MEMBER__ && status?.initialized && memberUrl && authMode !== 'owner.recoverAdministrator') return h('div', { className: 'lanw lanw-stack lanw-service-entry', 'data-service-entry': true },
            h('style', null, styles), h(PageHeading, { level: 'h1', title: t('serviceSignIn'), description: t('serviceSignInNote') }),
            h('a', { className: 'lanw-btn lanw-btn-primary', href: memberUrl, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', 'data-service-entry-link': true }, t('enterService')),
            h('p', { className: 'lanw-help lanw-service-address' }, memberUrl),
            !desktopWindow && h('details', { className: 'lanw-service-maintenance' }, h('summary', null, t('serverMaintenance')), h('p', { className: 'lanw-help' }, t('serviceMaintenanceNote')),
              actionButton(t('owner.recoverAdministrator'), { onClick: () => { setAuthMode('owner.recoverAdministrator'); setError(null); }, 'data-recover-administrator': true })));
          return h('div', { className: 'lanw lanw--sidebar', 'aria-busy': isBusy },
            h('style', { style: { display: 'none' } }, styles),
            h('aside', { className: 'lanw-secondary-nav' },
              h('div', { className: 'lanw-sidebar-heading' }, h('h2', { className: 'lanw-window-title' }, t('workspaceEntry')), workspaceActions),
              h('nav', { 'aria-label': t('workspaceNavigation') }, navigationGroups.map(([id, label, items]) => h('div', { key: id, className: 'lanw-navigation-group', role: 'group', 'aria-labelledby': `lanw-navigation-${id}`, 'data-navigation-group': id },
                h('span', { id: `lanw-navigation-${id}`, className: 'lanw-navigation-group-title' }, t(label)),
                items.map(value => actionButton(h(NavigationLabel, { id: value }, t(pageLabels[value])), {
                key: value, disabled: value === 'files' && ownFilesDisabled, className: 'lanw-secondary-item', id: `lanw-tab-${value}`, 'data-workspace-page': value,
                ...(['accounts', 'sessions', 'files', 'models', 'sharing', 'branding'].includes(value) && user?.role === 'admin' ? { 'data-admin-tab': value } : {}),
                'aria-current': currentPage === value ? 'page' : undefined, 'aria-controls': `lanw-panel-${value}`, onClick: () => selectPage(value),
              })))))),
            h('main', { className: 'lanw-page-main' },
            h(PageHeading, { level: 'h1', title: t(pageLabels[currentPage]), description: t(['sessions', 'files'].includes(currentPage) && user?.role !== 'admin' ? currentPage === 'files' ? 'ownFilesDescription' : 'ownSessionsDescription' : `${currentPage}Description`) }),
            h('select', { className: 'lanw-section-picker', value: currentPage, 'aria-label': t('workspaceNavigation'), onChange: event => selectPage(event.target.value) }, navigationGroups.map(([id, label, items]) => h('optgroup', { key: id, label: t(label) }, items.map(value => h('option', { key: value, value, disabled: value === 'files' && ownFilesDisabled }, t(pageLabels[value])))))),
            error && h('div', { className: 'lanw-notice lanw-error', role: 'alert' }, h('strong', null, `${t('backendError')} · ${error.code || 'REQUEST_FAILED'}`), h('p', null, error.message || t('requestFailed'))),
            notice && h('p', { className: 'lanw-notice lanw-success', role: 'status' }, t(notice)),
            !user ? authView() : h('div', { className: 'lanw-content lanw-stack' },
              h('section', { hidden: activeTab !== 'account', id: 'lanw-panel-account', 'aria-labelledby': 'lanw-tab-account' },
                AccountSection ? h(AccountSection, { embedded: true }) : h('div', { className: 'lanw-user', 'data-current-account': true, role: 'group', 'aria-label': t('currentAccount') },
                  h('div', { className: 'lanw-user-info' }, h('strong', { title: user.displayName || user.username }, user.displayName || user.username), h('span', { className: 'lanw-help', title: `@${user.username} · ${t(user.role === 'admin' ? 'adminRole' : 'memberRole')}` }, `@${user.username} · ${t(user.role === 'admin' ? 'adminRole' : 'memberRole')}`)),
                  h('span', { className: 'lanw-user-divider', 'aria-hidden': true }), actionButton(t('logout'), { onClick: () => run('logout') })),
                activeTab === 'account' && h(PasswordSettings, { run, pending: isBusy })),
              !snapshot ? h('p', { role: 'status' }, t(isBusy ? 'loading' : 'noSnapshot')) : h(React.Fragment, null,
                currentPage === 'preferences' && detailNotice('catalog'),
                ['account', 'usage'].includes(currentPage) && detailNotice('usage'),
                h('section', { hidden: activeTab !== 'preferences', id: 'lanw-panel-preferences', 'aria-labelledby': 'lanw-tab-preferences' }, snapshot.preferences ? h(PersonalCapabilities, { key: user.id, value: snapshot.preferences, pending: isBusy, onSave: fields => run('preferences.update', fields), onReload: async () => (await loadSnapshot()).preferences }) : h('p', { className: 'lanw-help' }, t('personalUnavailable'))),
                user.role === 'admin' && h('div', { hidden: activeTab !== 'admin', className: 'lanw-adminpanel' }, adminView()),
                user.role !== 'admin' && h('section', { hidden: activeTab !== 'content', id: `lanw-panel-${contentMode}`, 'aria-labelledby': `lanw-tab-${contentMode}` }, h(ContentManager, { pageMode: contentMode, onModeChange: setContentMode, users: [user], own: true, fileAccess: snapshot.preferences?.effective?.files !== false, request, active: activeTab === 'content', closeSettings: close, administratorId: user.id, returnPoint: previewReturn?.self && previewReturn.administratorId === user.id ? previewReturn : null, capturePreviewRelease: () => { const session = { ...auth.current }; return previewId => request('member.content', { operation: 'preview.close', previewId }, false, '', session); } })),
                activeTab === 'usage' ? h('section', { id: 'lanw-panel-usage', 'aria-labelledby': 'lanw-tab-usage' }, usageView()) : null))));
        }

        function installWorkspace(WorkspaceSection) {
          const id = 'lan-workspace-window', listeners = new Set();
          let opened = false, fileAction = null, previousPanel = ctx.layout.panelInfo.getSnapshot().activePanelId;
          const publish = value => { opened = value; for (const listener of listeners) listener(); };
          const startup = new AbortController(), startupTimer = setTimeout(() => startup.abort(), 8000);
          if (!window.__DSH_LAN_MEMBER__) {
            startupStatus = send({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }), signal: startup.signal })
              .then(response => response.json()).then(reply => { if (reply?.ok !== true) throw failure('INVALID_RESPONSE', t('invalidResponse')); return reply.result; });
            void startupStatus.then(result => { if (!startup.signal.aborted && result?.initialized === false) publish(true); }).catch(() => {}).finally(() => clearTimeout(startupTimer));
          }
          else clearTimeout(startupTimer);
          const launch = command => { fileAction = command; publish(false); };
          const closeFileAction = () => { fileAction = null; publish(false); };
          openWorkspaceWindow = () => { fileAction = null; publish(true); };
          function WorkspaceWindow() {
            const state = React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => fileAction ?? opened);
            const open = state === true;
            return h(React.Fragment, null, h('style', { style: { display: 'none' } }, styles),
              typeof state === 'object' && h(WorkspaceSection, { key: 'sidebar-file-action', fileAction: state, close: closeFileAction }),
              h(Modal, { open, onClose: () => publish(false), title: t('workspaceEntry'), closeLabel: t('close'), headless: true, className: 'lanw-workspace-window' },
                h('button', { type: 'button', className: 'lanw-window-close', 'aria-label': t('close'), onClick: () => publish(false) }, h(IconCloseOutlineRegular, { size: 16 })),
                h(WorkspaceSection, { close: () => publish(false) })));
          }
          // The native sidebar owns the row click. Restore its previous panel
          // synchronously, before React commits a different main surface, then
          // open our additive overlay. The selected Session is never changed.
          const disposers = [
            ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'multi-user-file-menu', order: 100 }, props => h(SidebarFileMenu, { ...props, launch }))),
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, () => null)),
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id, order: 20 }, WorkspaceWindow)),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order: 20, label: () => t('workspaceEntry') }, ({ size }) => h(IconUsersOutlineRegular, { size }))),
            ctx.layout.panelInfo.subscribe(() => {
              const selected = ctx.layout.panelInfo.getSnapshot().activePanelId;
              if (selected === id) { ctx.layout.selectPanel(previousPanel); openWorkspaceWindow(); }
              else previousPanel = selected;
            }),
          ];
          const dispose = () => { startup.abort(); clearTimeout(startupTimer); openWorkspaceWindow = undefined; listeners.clear(); disposers.reverse().forEach(dispose => dispose?.()); };
          dispose.open = () => publish(true);
          return dispose;
        }
        if (window.__DSH_LAN_MEMBER__) return require('@sunbigfly/dsh-multi-user-service/member-client').apply(ctx, { WorkspaceSection: Workspace, installWorkspace });
        ctx.effect(() => installWorkspace(Workspace));
      },
    };
  },
});
