# 插件索引

在 DSH 自定义插件索引中添加：

```text
https://github.com/sunbigfly/dsh-multi-user-service/releases/latest/download/index.json
```

索引随发行版发布，每个版本固定到完整 Git 提交 SHA。提交后运行 `npm run release:index` 生成 `output/index.json`，与安装包和校验和一同发布。
