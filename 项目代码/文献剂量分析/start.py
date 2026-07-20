#!/usr/bin/env python3
"""文献计量分析服务启动脚本，端口 6066"""
import os
import uvicorn

if __name__ == "__main__":
    workers = int(os.getenv("WORKERS", "1"))
    reload = os.getenv("RELOAD", "false").lower() == "true"
    print("=" * 60)
    print(f"文献计量分析服务 启动中... port=6066 workers={workers} reload={reload}")
    print("=" * 60)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=6066,
        workers=workers if not reload else 1,  # reload模式下只能用1个worker
        reload=reload,
        log_level="info",
        access_log=True,
    )
