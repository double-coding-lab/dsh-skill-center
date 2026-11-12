# dsh-skill-center

[English](./README.en.md) | 中文

DeepSeek Harness 的本机技能管理插件：在一个面板里查看、启停、创建、上传技能，并从 ClawHub 安装。

<details>
<summary>架构</summary>

```text
@double-coding/dsh-skill-center
├── 宿主 apply(ctx)
│   ├── skills.registerProvider            停用覆盖（rank 298）+ 内置 creator 技能（rank 350）
│   ├── agent/created → 每个 agent 再注册一份   覆盖 preset 作用域里的同名技能
│   ├── tools.register("skill_center_create") 把生成好的 SKILL.md 写入 ~/.dsh/skills
│   ├── webServer.register("/dsh-skill-center") 面板 API
│   └── storageDomain.open("dsh_skill_center")  策略与安装账本
└── 客户端
    ├── slots "main" + "sidebar.panellist"    技能中心面板
    └── uiWorkspace.startSession({ prompt })  创建技能时预填会话
```

</details>

## 能力

| | 说明 |
| --- | --- |
| 已安装 | 汇总 `~/.dsh/skills`、`~/.agents/skills` 和 agent preset 提供的技能，同名只显示一行 |
| 启停 | 不修改任何 `SKILL.md`；策略写入本地账本，由插件发布一条低优先级覆盖生效 |
| 详情 | 路径、全部副本、Markdown 渲染的 `SKILL.md` 正文、市场版本与本地修改状态 |
| 删除 | 本地与公共 Agent 目录都可删；符号链接与 preset 技能不允许 |
| 创建 | 面板输入一句话 → 新会话调用 `skill-center-creator` → 调工具落盘 |
| 上传 | `.zip`、整个文件夹、单个 `SKILL.md`；校验路径、文件数、体积，冲突先确认 |
| 发现 | ClawHub 下载榜、搜索、正文预览、安装 / 更新 / 卸载 |

## 安装

插件需要宿主提供 `skills` 服务；`tools`、`webServer`、`storageDomain` 缺失时对应能力降级，不影响启停。

```bash
# 从 npm（DSH Desktop / web profile）
dsh plugin --profile web add @double-coding/dsh-skill-center

# 源码联调
npm install
npm run build
dsh plugin --profile web add link:.
```

装好后重启 DSH，侧栏出现「技能中心」。

## 启停为什么不用改文件

同一份 `SKILL.md` 会被 Codex、Qoder 等工具共用；改 frontmatter 会污染用户文件，卸载插件后也无法还原。插件改为在自己的 provider 里对已停用的名字发布一条 `modelInvocable=false`、`userInvocable=false`、`rank=298` 的候选，压住宿主原生 provider（用户级 400/450、preset 299），源文件字节不变。

agent preset 把技能 provider 挂在更近的 preset 层，全局注册遮不住它，因此插件在每个存活 agent 的 ctx 里再注册一份。

## 创建链路

1. 「添加 → 创建技能」输入目标。
2. 面板调用 `uiWorkspace.startSession(undefined, { prompt, clearPreviousDraft: true })`，草稿为 `/skill-center-creator …`。
3. `skill-center-creator` 问清用途、触发场景和约束，起名并写正文。
4. 模型调用 `skill_center_create`，宿主侧校验后写入 `~/.dsh/skills/<name>/SKILL.md`。
5. 面板刷新出现新技能。

DSH 默认沙箱为 `workspace-write`，模型的原生写文件工具无法写入家目录，所以落盘必须由宿主工具完成。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 可写技能根 `$DSH_HOME/skills` |
| `DSH_AGENTS_HOME` | `~/.agents` | 公共 Agent 根 `$DSH_AGENTS_HOME/skills`（可查看、启停、删除，不在此新建） |

## 安全边界

- 路由只挂在宿主 web 服务上，不额外开端口；写请求校验同源。
- 路径由服务端重建，客户端只传技能名和 `owner`/`slug`。
- zip 校验相对路径、深度 ≤ 8、文件数 ≤ 500、解压总量 ≤ 64 MiB。
- 市场内容是第三方提示词：安装前展示正文，不自动安装，不执行技能内脚本。
- 策略存储不可读时 fail-closed：视为全部停用并禁止写入。

## 开发

```bash
npm run typecheck   # 宿主 + 客户端
npm run build       # tsc + esbuild
npm test            # 名称、frontmatter、zip、策略、provider 候选
npm run check       # 以上全部
```

参考实现只用于核对宿主契约与交互，不包含其仓库订阅、备份回退等模块。

## 第三方

`skills/skill-center-creator` 取自 [anthropics/skills](https://github.com/anthropics/skills) 的 `skill-creator`，按 Apache-2.0 使用，许可证见该目录下的 `LICENSE.txt`。改动限于 frontmatter 名称，以及补充 DeepSeek Harness 的落盘与环境说明。

## License

MIT