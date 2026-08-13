<a href="https://superlog.sh">
  <img width="1200" height="675" alt="Twitter 帖子 - 2" src="https://github.com/user-attachments/assets/c6ac3418-8e2f-4f8b-b25c-d75b3a094036" />

</a>

<div align="center" style="margin:24px 0;">

<br />

[![最后提交](https://img.shields.io/github/last-commit/superloglabs/superlog?labelColor=333333&color=666666)](https://github.com/superloglabs/superlog/commits/main)
[![提交活动](https://img.shields.io/github/commit-activity/m/superloglabs/superlog?labelColor=333333&color=666666)](https://github.com/superloglabs/superlog/graphs/commit-activity)
[![MCP 榜单](https://mcptoplist.com/badge/sh.superlog%2Fsuperlog.svg)](https://mcptoplist.com/server/sh.superlog%2Fsuperlog)
[![Apache 2.0 许可证](https://img.shields.io/badge/License-Apache_2.0-555555.svg?labelColor=333333&color=666666)](./LICENSE.md)
<br>
[![Discord](https://img.shields.io/discord/1511214206123380867?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/wJ56aRh8hx)
<a href="https://www.ycombinator.com"><img src="https://img.shields.io/badge/Y%20Combinator-P26-orange" alt="Y Combinator P26" /></a>
[![在 X 上关注 @superlogYC](https://img.shields.io/twitter/follow/superlogyc?logo=X&color=%23f5f5f5)](https://twitter.com/intent/follow?screen_name=superlogYC)

</div>

<p align="center">
  <a href="https://superlog.sh">官网</a>
  ·
  <a href="https://github.com/superloglabs/superlog">代码</a>
  ·
  <a href="https://github.com/superloglabs/skills">Skills</a>
  ·
  <a href="https://github.com/superloglabs/otel-helpers">Helpers</a>
  ·
  <a href="https://discord.gg/wJ56aRh8hx">Discord</a>
</p>

<p align="center">
  <a href="./README.md">English</a>
  ·
  <a href="./README.zh-CN.md">中文</a>
</p>

## 关于

[Superlog](https://superlog.sh) 是一个开源的智能体遥测系统。它接收 traces、logs 和 metrics，将嘈杂的信号归并为事件，并在你休息时持续监控基础设施。

## 安装

你可以在自己喜欢的代码智能体中使用我们的 [Skills](https://superlog.sh)，将 Superlog 安装到你的项目中：

```
运行 npx skills add superloglabs/skills --all，并使用这些 Skills 将 Superlog 安装到此项目中
```



## Superlog 是什么？

Superlog 是一个面向 OpenTelemetry 数据的开放核心可观测性工作区。它接收 traces、logs 和 metrics，将嘈杂的信号归并为事件，并为团队提供一个本地优先的生产系统调试界面。

此仓库包含完全开源且免费的社区版：

- Web 应用和 API
- OTLP 数据接收代理
- 用于事件归并和后台任务的 Worker 进程
- Postgres 数据库结构，以及基于 ClickHouse 的遥测查询
- 可插拔调查运行时的智能体运行器接口
- 默认的 `community` 智能体运行器，用于记录本地事件摘要

我们还提供托管版 Superlog Cloud，包含免费套餐、按量付费套餐和月度积分包。

## 快速开始

前置要求：

- Node.js 20+
- pnpm 9+
- Docker

安装依赖：

```bash
pnpm install
```

启动本地服务栈：

```bash
docker compose up -d
pnpm --filter @superlog/db db:migrate
pnpm dev
```

默认的本地服务地址：

- Web：`http://localhost:5173`
- API：`http://localhost:4100`
- OTLP 接收端：`http://localhost:4101`

## 开发

运行类型检查：

```bash
pnpm typecheck
```

## 仓库结构

- `apps/web` - Vite/React 前端
- `apps/api` - HTTP API
- `apps/proxy` - OTLP 数据接收代理
- `apps/worker` - 后台 Worker 和智能体编排
- `packages/db` - Drizzle 数据库结构和迁移
- `packages/fingerprint` - 遥测指纹处理工具

## 许可证

Superlog 采用 [Apache License 2.0](./LICENSE.md) 许可证。
