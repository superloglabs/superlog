# 为 Superlog 做贡献

<p align="center">
  <a href="./CONTRIBUTING.md">English</a>
  ·
  <a href="./CONTRIBUTING.zh-CN.md">中文</a>
</p>

感谢你为 Superlog 做贡献。Superlog 由一个小团队打造，优秀的贡献通常会在几小时内得到审阅并合并——你的帮助确实会影响产品的发展。

> **第一次参与开源项目？** 可以参考 [firstcontributions/first-contributions](https://github.com/firstcontributions/first-contributions)，其中有一份 5 分钟即可读完的 fork → branch → PR 流程介绍。这里的操作方式相同。

## 参与方式

你不一定要编写代码才能提供帮助：

- **报告 Bug 和边界情况** —— 提交包含最小复现步骤的 issue
- **改进文档** —— 本文件、[docs/](docs/) 目录以及代码注释
- **编写测试** —— 当前整体覆盖率约为 44%；`apps/api` 和 `apps/worker` 中仍有一些模块没有测试
- **整理 issue** —— 复现问题、添加标签、关联重复 issue
- **提交 PR** —— 请参阅下面的流程
- **参与 Discord** —— `#support` 是新用户最先进入的频道
- **分享项目** —— 写下你使用 Superlog 的方式

## 行为准则

本项目遵循 [Contributor Covenant](https://www.contributor-covenant.org/) 的精神：保持尊重、善意看待他人、专注于工作。我们目前还没有单独的 `CODE_OF_CONDUCT.md`；如果你想添加，请先通过 issue 提议。

## 前置要求

- **Node.js 20+** —— `node --version`
- **pnpm 9+** —— 仓库通过 `packageManager` 固定使用 `pnpm@9.12.0`
- **Docker**，并支持 `docker compose` —— 用于运行 Postgres、ClickHouse 和 OTel Collector
- 一个已配置 SSH 或 HTTPS 认证的 GitHub 账号

## 快速开始

```bash
git clone https://github.com/superloglabs/superlog.git
cd superlog
pnpm install
docker compose up -d
pnpm --filter @superlog/db db:migrate
pnpm dev
```

默认本地服务：

| 服务 | 地址 |
| ---- | ---- |
| Web 应用 | http://localhost:5173 |
| API | http://localhost:4100 |
| OTLP 代理 | http://localhost:4101 |
| 示例应用 | http://localhost:3005 |

如果首次启动时出现问题，可以运行 `pnpm dev:portless:status` 查看已启动的服务。要彻底重启，请运行：

```bash
pnpm dev:portless:stop && pnpm dev:portless
```

`dev:portless*` 系列命令会使用每个 worktree 独立的端口和数据库，避免并行 worktree 之间发生冲突。详情请参阅 `scripts/portless-stack.sh`。

## 常用命令

| 命令 | 作用 |
| ---- | ---- |
| `pnpm dev` | 通过 Turborepo 运行所有应用 |
| `pnpm dev:portless` | 使用每个 worktree 独立的端口和数据库运行（推荐） |
| `pnpm dev:portless:env` | 输出 portless 服务栈设置的环境变量 |
| `pnpm build` | 构建所有包 |
| `pnpm typecheck` | 对整个 monorepo 执行 TypeScript 类型检查（Turbo） |
| `pnpm lint` | Biome 检查（只读） |
| `pnpm format` | Biome 格式化并写回文件 |
| `pnpm --filter @superlog/<pkg> <script>` | 在指定包中运行脚本 |
| `pnpm --filter @superlog/db db:migrate` | 应用 Postgres 数据库迁移 |
| `pnpm demo:bootstrap:acme` | 创建 Acme Inc. 示例组织和项目 |
| `pnpm demo:seed:acme` | 写入 Acme Inc. 遥测数据（适合首次体验） |
| `pnpm demo:seed:rich` | 写入包含多种信号的丰富示例数据 |
| `pnpm demo:seed:everything` | 写入全部示例数据 |
| `pnpm conductor:setup` | 一次性配置 Conductor 开发环境 |
| `pnpm worktree:bootstrap` | 配置新的 Git worktree（端口、数据库和遥测） |

## 测试

测试使用 Node 内置的测试运行器，通过 `tsx` 执行：

```bash
pnpm --filter @superlog/api test
pnpm --filter @superlog/fingerprint test
pnpm --filter @superlog/billing test
```

新测试请放在源码旁，并命名为 `*.test.ts`——现有的 `tsx --test src/**/*.test.ts` glob 会自动发现它们。创建 PR 前请运行 `pnpm typecheck`；TypeScript 使用严格模式（`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`）。

如果你的改动涉及 OTLP 接收、智能体编排、Webhook 投递或事件生命周期，请至少添加一个测试。这些是对用户最重要的功能区域。

## 环境变量

每个应用下的 `.env.example` 文件是环境变量的唯一参考来源——将它们分别复制为 `.env`（或者使用 `scripts/with-stack-env.sh` 一次性加载所有变量），并填写所需的密钥：

| 文件 | 作用 |
| ---- | ---- |
| [`apps/api/.env.example`](apps/api/.env.example) | API、认证、计费、邮件、Slack/Linear OAuth、Loops |
| [`apps/worker/.env.example`](apps/worker/.env.example) | 智能体运行器、GitHub App、Linear、ClickHouse 轮询 |
| [`apps/web/.env.example`](apps/web/.env.example) | Vite/React 客户端环境变量 |
| [`apps/proxy/.env.example`](apps/proxy/.env.example) | OTLP 代理 |
| [`packages/db/.env.example`](packages/db/.env.example) | 本地数据库连接 |
| [`apps/sample/.env.local.example`](apps/sample/.env.local.example) | 示例应用 OTel 导出器配置 |

如果某个变量没有出现在对应应用的示例文件中，请在猜测之前检查 `apps/api/src/env.ts` 或相关的 `*.test.ts` 配置文件。

如果要完整配置 GitHub 集成（包括 **Connect GitHub** 流程和由智能体创建 PR 的功能），请参阅 [`docs/github-app-setup.md`](docs/github-app-setup.md)。该文档介绍了如何注册 GitHub App，以及如何在 API 和 Worker 中配置相关凭据。

## 代码风格

仓库使用 **Biome**（不是 ESLint/Prettier）。完整配置见 `biome.json`：

- 2 个空格缩进，行宽 100 个字符
- 双引号、分号、尾随逗号
- 强制排序 import —— 运行 `pnpm format` 自动修复

`pnpm lint` 是只读命令。`pnpm format` 会重写文件。推送 PR 前，两者都应通过；`pnpm typecheck` 是最严格的检查。

## 提交信息和分支名称

分支名称采用 `<你的 GitHub 用户名>/<kebab-summary>` 格式：

```text
your-github-username/short-kebab-description
arseniycodes/mcp-install-pill
ash/slack-private-channels
```

本仓库的 PR 标题有多种风格，请匹配你所修改区域的风格：

| 风格 | 示例 |
| ---- | ---- |
| `area: imperative summary` | `fingerprint: add tsx to lockfile`、`worker: add pgboss:migrate` |
| `fix(area): summary` | `fix(slack): use the incident's pinned installation for interactivity buttons` |
| `feat(area): summary` | `feat(worker): link filed Linear ticket in agent-opened PR body` |
| 普通英文（跨区域） | `Add AWS connect + resource inventory` |

标题应少于 72 个字符。使用正文说明“为什么”——diff 已经展示了“改了什么”。

## Pull Request

1. **一个 PR 只处理一个问题。** 如果修复 Bug 时发现无关的清理工作，请拆成第二个 PR。
2. **非简单改动可以尽早创建 Draft。** Draft 能更早获得反馈。
3. **在 PR 描述中关联 issue**（使用 `Fixes #38`），这样合并后会自动关闭对应 issue。
4. **推送前运行：**
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm --filter @superlog/<affected-pkg> test
   ```
5. **保持 PR 精简。** 低于约 400 行是理想范围。大型 PR 容易被退回。
6. **快速处理 review。** 后续提交通常会在 24 小时内得到反馈。

### 通常不会合并的内容

- 没有实际修复内容的顺手格式化或只改错别字的 PR
- 大规模重构或重写——请先通过 issue 对齐方向
- 修改 OTLP 接收、智能体编排、Webhook 或事件生命周期但没有测试的 PR
- 没有充分理由就新增运行时依赖的 PR
- 未经事先讨论就修改计费（`packages/billing/`）或认证（`apps/api/src/auth.ts`）的 PR

如果不确定改动是否合适，请先创建 issue。这样比提交 PR 后被要求返工省时得多。

## 提交 issue

- **一个 Bug 对应一个 issue。** 将多个问题放在一起会拖慢排查。
- **对于 Bug：** 提供最小复现、预期与实际结果、环境信息（`pnpm dev:portless:status` 输出）以及相关日志行。
- **对于功能请求：** 先说明使用场景，再提出方案。范围越小，处理越快。
- **对于使用问题：** 请在 [Discord](https://discord.gg/wJ56aRh8hx) 的 `#support` 提问，不要创建 issue。issue 仅用于 Bug 和功能请求。
- **对于安全问题：** 请参阅 [SECURITY.md](SECURITY.md)，不要提交公开 issue。

### Issue 标签

| 标签 | 含义 |
| ---- | ---- |
| `bug` | 已确认或很可能存在的缺陷 |
| `documentation` | 仅涉及文档的改动 |
| `enhancement` | 新功能或改进 |
| `good first issue` | 适合首次参与者的明确范围任务 |
| `help wanted` | 维护者希望有人协助 |
| `duplicate` | 已有重复 issue |
| `invalid` | 不可执行或不可操作 |
| `question` | 需要进一步澄清 |
| `wontfix` | 超出范围或按设计如此 |

并非每个 issue 都会被立即添加标签——如果没有标签，维护者会在后续分诊。

## 生成式 AI 政策

欢迎使用生成式 AI 工具来**理解**代码库、**头脑风暴**方案以及**校对** PR 描述。最终提交的贡献属于你自己——请确保你理解并验证了提交内容。

如果使用生成式 AI 起草了 PR 中的重要内容，请在 PR 描述中简要披露（写一行即可），例如：

> 使用 Claude 搭建了 `webhooks.ts` 的测试用例，并经过人工审阅和调整。

不要使用 AI：

- 提交你不理解的代码、issue 或评论
- 解决你在没有 AI 的情况下无法解决的问题
- 批量创建 issue 或 PR
- 冒充人类贡献者（例如伪造 `Co-authored-by` trailer 或虚假的 review 回复）

维护者可能会关闭低价值的 AI 生成 PR，而不提供详细反馈。AI 辅助贡献的标准与人工贡献相同：必须是你理解并能够解释的内容。

## 提交之后

- **首次回复：** 通常在几小时内，很多时候当天就会收到。如果 2 个工作日内没有回应，请在 [Discord](https://discord.gg/wJ56aRh8hx) 的 `#general` 频道提醒维护者。
- **Review：** 通常会采用“请求修改”的方式（“处理这 3 个小问题后即可合并”）。后续修改通常会在 24 小时内得到反馈。
- **合并：** 根据项目的 GitHub 设置执行 squash 或 rebase。
- **发布：** 改动会分批发布——并不是每个 PR 都会立即对用户可见。

我们以产品和团队为出发点审阅贡献。如果某个想法不适合项目，我们会说明原因，但最终是否合并由维护者决定。这是小团队项目的正常流程，并不代表对贡献者的否定。

## 安全

请将漏洞报告发送到 [`SECURITY.md`](SECURITY.md) 中列出的地址。请不要提交公开 issue。

## 获取帮助

- [Discord](https://discord.gg/wJ56aRh8hx) —— `#general` 用于一般交流，`#support` 用于安装和配置问题
- GitHub issues 用于 Bug 和功能请求
- 创建 issue 时，请附上 `pnpm dev:portless:status` 的输出和最小复现

## 致谢

贡献者会被记录在发布说明和[贡献者图表](https://github.com/superloglabs/superlog/graphs/contributors)中。持续提交高质量贡献的参与者可能会获得提交权限。

## 许可证

你同意根据 [Apache License 2.0](LICENSE.md) 许可证授权你的贡献。
