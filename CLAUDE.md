# 项目 compress — qmd 检索补充规范

> 通用规则见 `~/.claude/CLAUDE.md` 中的「代码检索 token 节省规范」。
> 本文件只补充本项目的环境差异和 collection 配置，**不重复全局规则**。
> 与全局规则冲突时，**立即中断询问用户**。

## 0. 环境说明
- qmd skill：办公 Windows / 家庭 Mac 本地 CLI（首选）
- qmd-search：远程 MCP 服务（兜底）
- 仅这两者可用作代码检索

## 1. 本项目 qmd collection

```
compress    （pattern: **/*.{ts,tsx,vue,js,jsx,rs,css,html,md}）
slim-video  （仅 markdown 文档）
```

代码搜索默认带 `-c compress`；查文档/营销页才用 `-c slim-video`。

## 2. 强制规则（与全局一致，再次强调）

- **禁止** `qmd query`（会触发 1.28GB 模型下载）
- **禁止** `Read` 项目源码文件（`Z/src/**`、`native-host/src/**` 等），只看 qmd snippet
- **禁止** `grep` / `find` / `ls -R` / `glob`
- 单次 `qmd search` 命令必须 `2>&1 | head -40`
- 看到进度条/模型下载立即 Ctrl-C
- snippet 不足时用 `qmd get <path> -l <start>:<end>` 精确取行，**禁止整文件读**
- 三轮检索仍无结果 → 停下，按全局规则输出提示语

## 3. 索引刷新

- 代码可能变更过（git pull / 新增文件 / 修改）→ 先 `qmd embed`
- 确定无变更 → 跳过
- 不在索引内的文件（如 `node_modules`、构建产物）禁止搜索/读取

## 4. 自动记忆

- 重大重构 / 架构变更完成后，自动记录到 claude-mem memory
- 用户的关键反馈（如 token 节省规范）需写入 `~/.claude/projects/-Users-jieone-hello-compress/memory/`
