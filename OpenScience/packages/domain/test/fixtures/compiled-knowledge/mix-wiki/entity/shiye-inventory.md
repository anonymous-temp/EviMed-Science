---
type: entity
title: shiye-inventory
description: 门店库存系统的代码仓库，Monorepo 结构，含门店端应用、总部看板、API 与离线同步协议包。
tags: [仓库, monorepo, 代码, 拾页书店]
---

# shiye-inventory

`shiye-inventory` 是拾页书店门店库存系统的代码仓库，采用 Monorepo 结构，状态为开发中、未上线，试点计划 2026-05-06（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "状态：开发中，未上线。试点计划 2026-05-06。")）。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/api/` | Fastify + PostgreSQL 16，库存流水与对账 |
| `apps/store-app/` | 门店端，React Native，离线优先（SQLite + 同步队列） |
| `apps/hq-board/` | 总部看板，Next.js |
| `packages/isbn/` | ISBN-10/13 规范化与校验位 |
| `packages/sync/` | 离线同步协议（last-scan-wins，5 分钟窗口内标记人工确认） |
| `scripts/import-yinbao.ts` | 每晚 02:30 拉银豹的 CSV（对方 02:00 导出） |
| `scripts/migrate-excel.ts` | 历史 Excel → 流水，只迁 12 个月 |

结构依据 README 的目录说明（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "sync/       # 离线同步协议（last-scan-wins，5 分钟窗口内标记人工确认）")）。

## 本地运行

```bash
pnpm i
docker compose up -d db        # postgres:16, 端口 5433（不是 5432，和别的项目冲突）
pnpm --filter api dev          # http://localhost:4010
pnpm --filter store-app start
```

环境变量见 `.env.example`；`YINBAO_FTP_*` 需向小唐索取，不要提交（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "环境变量见 `.env.example`。`YINBAO_FTP_*` 找小唐要，不要提交。")）。数据库端口使用 5433 而非 5432，以避免与其他项目冲突（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "docker compose up -d db        # postgres:16, 端口 5433（不是 5432，和别的项目冲突）")）。

## 已知问题

- transfer 两端门店不同时在线时，调入方会短暂出现负库存（#41）（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "transfer 两端门店不同时在线时，调入方会短暂出现负库存（#41）")）。
- 银豹 CSV 的编码是 GBK，偶尔混入 UTF-8 BOM（#37）（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "银豹 CSV 的编码是 GBK，偶尔混入 UTF-8 BOM（#37）")）。
- hq-board 在 Safari 15 上图表不渲染（#52），决定不修，因为拾页总部使用 Edge（[README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md "hq-board 在 Safari 15 上图表不渲染（#52，不修，拾页总部用的是 Edge）")）。

## 关系

- 是 [拾页书店门店库存系统](拾页书店门店库存系统.md) 的实现仓库，由 [栖木软件工作室](栖木软件工作室.md) 维护。
- 其中的同步协议对应 [离线优先盘点与同步](../concept/离线优先盘点与同步.md)，数据模型对应 [库存流水模型](../concept/库存流水模型.md)。

## 来源

- [shiye-inventory README](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md)
- [门店清单与库存快照-0315](viking://user/ulab0001/resources/p/pmix01/sources/src_5330842d732886722cfe220978a40b37.md)
