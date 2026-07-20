#!/usr/bin/env python3
"""
论文智能预审服务 - 启动脚本
端口: 6009

环境变量（均有默认值，可按需覆盖）：
  LLM_MAX_CONCURRENT    同时向 LLM API 发出的最大请求数（默认 8）
  MAX_CONCURRENT_REVIEWS 同时执行的审稿任务上限（默认 5）
  HTTP_POOL_SIZE        全局 HTTP 连接池上限（默认 100）
  HTTP_POOL_PER_HOST    每个主机 HTTP 连接上限（默认 30）
  WORKERS               uvicorn 工作进程数（默认 1；>1 时需 Redis 共享 job_store）
"""
import os
import sys
import uvicorn

if __name__ == "__main__":
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")

    try:
        import torch
        print("GPU:", "可用（已强制禁用）" if torch.cuda.is_available() else "已禁用，使用 CPU")
    except ImportError:
        print("torch 未安装，使用 CPU")

    # 尝试启用 uvloop 以获得更高的异步 I/O 性能
    loop = "auto"
    try:
        import uvloop  # noqa: F401
        loop = "uvloop"
        print("事件循环: uvloop")
    except ImportError:
        print("事件循环: asyncio（安装 uvloop 可进一步提升并发性能）")

    workers = int(os.getenv("WORKERS", "1"))
    # 注意：workers > 1 时 job_store 为各进程独立内存，需配合 Redis 共享状态
    if workers > 1:
        print(f"[警告] WORKERS={workers}，job_store 为内存存储，多进程间状态不共享。")
        print("       若需多进程，请先将 job_store 迁移至 Redis。")

    print("=" * 60)
    print(f"论文智能预审服务 启动中... workers={workers}")
    print(f"  LLM 并发上限   : {os.getenv('LLM_MAX_CONCURRENT', '8')}")
    print(f"  审稿并发上限   : {os.getenv('MAX_CONCURRENT_REVIEWS', '5')}")
    print(f"  HTTP 连接池    : {os.getenv('HTTP_POOL_SIZE', '100')} (per_host={os.getenv('HTTP_POOL_PER_HOST', '30')})")
    print(f"API 文档         : http://localhost:6009/docs")
    print("=" * 60)

    uvicorn.run(
        "src.api.main:app",
        host="0.0.0.0",
        port=6009,
        workers=workers,
        loop=loop,
        log_level="info",
        access_log=True,
        # reload=False（生产模式，不监听文件变动）
    )
