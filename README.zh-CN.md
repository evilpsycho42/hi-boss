# Hi-Boss

[English README](README.md)

通过 Telegram 编排 Codex / Claude Code 智能体，支持持久化通信、可编辑记忆，以及非阻塞并行执行。

亮点：
- 提供商灵活：支持官方直连与中转方案。
- 内置记忆系统：每个智能体都有可读、可直接编辑的 Markdown 记忆。
- 信封（Envelope）系统：提供可持久化、可审计的 agent↔agent / agent↔user 通信流。
- 非阻塞委派：后台/leader 智能体可并行处理重任务，也可按领域注册专用智能体。

## 赞助

[![YesCode logo](docs/assets/sponsors/yescode-logo.png)](https://co.yes.vg/register?ref=KKYC1Z0)

YesCode 是稳定可靠、价格合理的 Claude Code/Codex 中转服务提供商。

## 安装

在 setup 前，请先确保至少安装并可运行一个 provider CLI：
- **Claude Code** (`claude --version`)
- **Codex** (`codex exec --help`)

通过 npm 安装：

```bash
npm i -g hiboss
hiboss setup
hiboss daemon start --token <boss-token>
```

首次启动（setup + 启动 daemon）：

```bash
hiboss setup
hiboss daemon start --token <boss-token>
```

升级：

```bash
hiboss daemon stop --token <boss-token>
npm i -g hiboss@latest
```

提示：升级后重启 daemon：

```bash
hiboss daemon start --token <boss-token>
```

源码开发说明见：`docs/index.md`。

## Setup

`hiboss setup` 会初始化本地状态，并且仅输出一次 token。

| 项目 | 路径 |
|---|---|
| 数据根目录（默认） | `~/hiboss/` |
| 数据根目录（覆盖） | `$HIBOSS_DIR` |
| Daemon 内部文件（db/socket/log/pid） | `${HIBOSS_DIR:-$HOME/hiboss}/.daemon/` |
| Agent 长期记忆文件 | `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/MEMORY.md` |
| Agent 每日记忆目录 | `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/memories/` |

目录结构示意：

```text
${HIBOSS_DIR:-$HOME/hiboss}/
  .daemon/
  agents/<agent-name>/internal_space/
    MEMORY.md
    memories/
```

修复 / 重置：
- 健康 setup 重跑（安全无副作用）：`hiboss setup`
- setup 异常/不完整（非破坏）建议走配置导出+回放流程：

```bash
hiboss daemon stop --token <boss-token>
hiboss setup export --out ./hiboss.setup.json
# 编辑 ./hiboss.setup.json
hiboss setup --config-file ./hiboss.setup.json --token <boss-token> --dry-run
hiboss setup --config-file ./hiboss.setup.json --token <boss-token>
hiboss daemon start --token <boss-token>
```

- 旧版单 Agent Telegram 场景（只有 speaker，没有 leader）的标准修复模板。保存为 `./hiboss.repair.v2.json`，并填写占位符：

```json
{
  "version": 2,
  "boss-name": "<your-name>",
  "boss-timezone": "<IANA-timezone>",
  "telegram": {
    "adapter-boss-id": "<telegram-username-without-@>"
  },
  "agents": [
    {
      "name": "nex",
      "role": "speaker",
      "provider": "<claude-or-codex>",
      "description": "Telegram speaker agent",
      "workspace": "<absolute-workspace-path>",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": [
        {
          "adapter-type": "telegram",
          "adapter-token": "<telegram-bot-token>"
        }
      ]
    },
    {
      "name": "kai",
      "role": "leader",
      "provider": "<claude-or-codex>",
      "description": "Background leader agent",
      "workspace": "<absolute-workspace-path>",
      "model": null,
      "reasoning-effort": null,
      "permission-level": "standard",
      "bindings": []
    }
  ]
}
```

```bash
hiboss daemon stop --token <boss-token>
hiboss setup --config-file ./hiboss.repair.v2.json --token <boss-token> --dry-run
hiboss setup --config-file ./hiboss.repair.v2.json --token <boss-token>
hiboss daemon start --token <boss-token>
```

说明：setup config apply 是全量对齐（full reconcile），会重新生成 agent token（只打印一次）。

完整重置（破坏性）：

```bash
hiboss daemon stop --token <boss-token>
rm -rf "${HIBOSS_DIR:-$HOME/hiboss}"
hiboss setup
hiboss daemon start --token <boss-token>
```

提示：大多数命令都支持 `--token <token>`；省略时会读取 `HIBOSS_TOKEN`。

## Telegram

Hi-Boss 通过 Telegram Bot 将智能体接入 Telegram。

1) 通过 @BotFather 创建 Telegram Bot Token。

2) 将 Bot 绑定到 `speaker` 智能体（`hiboss setup` 创建的 speaker 会自动绑定；这个命令主要用于额外 speaker）：

```bash
hiboss agent set --token <boss-token> --name <speaker-agent-name> --role speaker --bind-adapter-type telegram --bind-adapter-token <telegram-bot-token>
```

3) 在 Telegram 中给 Bot 发消息即可和智能体对话。

仅 Boss 可用的 Telegram 命令：
- `/status`：查看该绑定 agent 的 `hiboss agent status`
- `/new`：请求刷新该绑定 agent 的会话
- `/abort`：取消当前运行并清空该绑定 agent 已到期待处理的 inbox

## Agent

通过 CLI 管理智能体（创建 / 更新 / 删除），也可以通过 `permission-level` 把管理权限委托给可信智能体。

创建/注册新智能体：

```bash
hiboss agent register --token <boss-token> --name ops-bot --role leader --provider codex --description "AI assistant" --workspace "$PWD"
```

更新智能体（手动配置）：

```bash
hiboss agent set --token <boss-token> --name ops-bot --provider codex --permission-level privileged
```

删除智能体：

```bash
hiboss agent delete --token <boss-token> --name ops-bot
```

查看列表 / 状态：

```bash
hiboss agent list --token <boss-token>
hiboss agent status --token <boss-token> --name ops-bot
```

### 权限级别

Hi-Boss 区分两件事：
- **Boss 标记消息**（`fromBoss` / 提示词中的 `[boss]`）对应适配器身份（例如 Telegram 用户名）。
- **授权级别**（`permission-level`）决定某个 token 能执行哪些 CLI/RPC 操作。

可用级别：`restricted`、`standard`、`privileged`、`boss`。

设置权限级别：

```bash
hiboss agent set --token <boss-token> --name <agent-name> --permission-level <level>
```

### Boss 级智能体（委托管理）

如果你希望某个智能体仅通过聊天就能执行 Hi-Boss 管理操作（注册/删除 agent、重绑适配器等），可以给它 `permission-level: boss`：

```bash
hiboss agent set --token <boss-token> --name <agent-name> --permission-level boss
```

然后你可以在 Telegram 里直接让该智能体执行管理任务（例如“新增一个 agent”“删除某个 agent”“更新绑定”）。当然你也可以始终手动使用 `hiboss agent register|set|delete`。

这项权限非常强：boss 级 token 可以执行任何 boss 权限操作。请仅授予你完全信任的智能体。

## 记忆系统

每个 agent 的记忆位于 `${HIBOSS_DIR:-$HOME/hiboss}/agents/<agent-name>/internal_space/`：
- `MEMORY.md`：长期记忆
- `memories/YYYY-MM-DD.md`：每日记忆文件

## 文档

- `docs/index.md`：文档入口（规格索引）
- `docs/spec/index.md`：Spec 总入口与导航
- `docs/spec/cli.md`：CLI 命令面与链接
- `docs/spec/adapters/telegram.md`：Telegram 适配器行为
