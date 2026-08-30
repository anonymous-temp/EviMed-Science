# 2026-08-30 热修留痕：这个 release 不完全等于它声称的 revision

`release-manifest.json` 的 `source.revision` 写的是
`9f748cae352965cc5800ade91f37f8492e3653be`。**这份树不完全是那个提交。**

## 偏离的那一个文件

```
OpenScience/apps/server/src/agentRuns.mjs
sha256  9ee207c31118fef1d20f9cf6a53906be1c911bbca0076539e1851818ab9e6466
```

它是 `9f748cae` 的同名文件，加上一处最小补丁：`scheduleMonitor` 的分离 promise
补了 `.catch()`。补丁来源提交 **`e9d1c7265`**（`main` 分支，那次提交里的修法与四条
阴性对照测试）。**只取了那一处 catch，没有取该提交的其它任何内容** —— 中间隔着 108 个
提交，整份文件搬过来在这棵旧树里连 import 都过不去。

## 为什么必须打这个补丁

`web-open-science-web-1` 崩溃重启 48 次、每次启动后约 2 秒被杀，API 对全体用户不可用。
启动时认领上一条命的运行中任务走的是分离路径，monitor 调运行时控制器拿到 502
`runtime_cleanup_failed`，未捕获拒绝直接终止进程。一个清不掉的孤儿容器把整个 API 打下线。
打完补丁后 `restarts=0`。

## 同时被改钉的两个 imageId，其中一个是不可复原的断链

| | 原钉 | 现钉 | 说明 |
|---|---|---|---|
| `web.imageId` | `sha256:3d25a011…` | `sha256:bc7ac313…` | 预期内：热修镜像本来就是新构建的 |
| `runtime.imageId` | `sha256:7de5c5e1…` | `sha256:9583d089…` | **断链** |

runtime 那一条不是正常升级。原镜像
`open-science-opencode:opencode-1.17.13-uv-0.11.26-d0505d25` 在 2026-08-30 清理磁盘时
被误删 —— 当时的判据只有「没有容器在用」，漏掉了 `.env` 的
`OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE` 与本清单的 `runtime.imageId` 两处引用。

重建用的是同一份 Dockerfile、同一个 `OPENCODE_VERSION=1.17.13` 与 `UV_VERSION=0.11.26`，
两个二进制都过了 Dockerfile 里钉死的 sha256 校验（`157afa28…` / `6426a73c…`），
**功能上等价**。但构建时间不同、debian 源上的依赖包版本可能已经变动，
**镜像不是同一份字节，原 imageId 不可复原**。

所以：「现在跑的运行时镜像，就是当初认证过的那一份」——**这条链在 2026-08-30 断了**，
只能靠改钉消红，不能靠重建复原。下次全量发布重新签发清单时，这条断链才真正翻篇。

平台自己发现了它：镜像重建完成后 `/api/ready` 的红从 `runtime_image_unavailable`
变成了 `runtime_image_provenance_mismatch`，没有人去告诉它。

## 由此定下的纪律

**生产删除三判据**：无运行使用 ∧ 无配置引用（grep `.env` / compose / systemd）
∧ 无清单或回执引用 —— 三者同时满足才可删。见
`docs/superpowers/plans/2026-08-29-development-principles-and-text-output-todo.md` J 节。
