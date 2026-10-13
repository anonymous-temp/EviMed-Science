---
type: entity
id: shiye-inventory
title: shiye-inventory
entity_type: project
description: 拾页书店门店库存管理系统的代码仓库，以 monorepo 组织门店端、总部看板与共享包。
aliases: [shiye-inventory 仓库]
sources:
  - viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md
---

## 概述

`shiye-inventory` 是[门店库存管理系统](./门店库存管理系统.md)的代码仓库，采用 monorepo 结构，状态为「开发中，未上线」，试点计划 2026-05-06（`src_4d515bae3e64e62ddb71a8f69cc89728.md`）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `apps/api` | Fastify + PostgreSQL 16，库存流水与对账 |
| `apps/store-app` | 门店端，React Native，离线优先（SQLite + 同步队列） |
| `apps/hq-board` | 总部看板，Next.js |
| `packages/isbn` | ISBN-10/13 规范化与校验位 |
| `packages/sync` | [离线同步协议](./离线同步协议.md)（last-scan-wins，5 分钟窗口内标记人工确认） |
| `scripts/import-yinbao.ts` | 每晚 02:30 拉取银豹 CSV（对方 02:00 导出） |
| `scripts/migrate-excel.ts` | 历史 Excel → 流水，只迁 12 个月 |

## 运行与已知问题

本地运行需 `pnpm i`、`docker compose up -d db`（postgres:16，端口 5433），API 默认监听 `http://localhost:4010`；环境变量见 `.env.example`，其中 `YINBAO_FTP_*` 需向[小唐](./小唐.md)索取且不得提交（`src_4d515bae3e64e62ddb71a8f69cc89728.md`）。

已记录问题包括：transfer 两端门店不同时在线时调入方短暂出现负库存（#41）、银豹 CSV 编码为 GBK 偶尔混入 UTF-8 BOM（#37）、hq-board 在 Safari 15 上图表不渲染（#52，决定不修）（`src_4d515bae3e64e62ddb71a8f69cc89728.md`）。

## 来源

- [src_4d515bae3e64e62ddb71a8f69cc89728](viking://user/ulab0001/resources/p/pmix01/sources/src_4d515bae3e64e62ddb71a8f69cc89728.md)
