#!/usr/bin/env python3
"""
快速启动脚本
"""
import sys
import argparse
import uvicorn
from config.settings import setup_logging


def main():

    setup_logging()
    parser = argparse.ArgumentParser(description="科研选题智能分析Agent系统")
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="API服务监听地址"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=6008,
        help="API服务监听端口"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="启用热重载（开发模式）"
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="运行测试分析"
    )

    args = parser.parse_args()

    if args.test:
        # 运行测试分析
        import asyncio
        from services.task_service import task_service

        async def run_test():
            print("=" * 60)
            print("科研选题智能分析Agent - 测试运行")
            print("=" * 60)

            test_input = "林可霉素导致肝损伤的机制研究"
            print(f"\n测试输入: {test_input}\n")

            task = await task_service.create_task(test_input)
            print(f"创建任务: {task.task_id}")

            completed = await task_service.process_task(task.task_id)
            print(f"任务状态: {completed.status}")

            if completed.status == "completed":
                report = await task_service.get_task_report(task.task_id)
                print("\n" + "=" * 60)
                print("生成的报告预览:")
                print("=" * 60)
                content = report["report"]["content"]
                print(content[:2000] + "\n... [报告内容已截断] ...")
            else:
                print(f"任务失败: {completed.error_message}")

        asyncio.run(run_test())
    else:
        # 启动API服务
        print(f"启动API服务: http://{args.host}:{args.port}")
        print(f"API文档: http://{args.host}:{args.port}/docs")

        uvicorn.run(
            "app.main:app",
            host=args.host,
            port=args.port,
            reload=args.reload
        )


if __name__ == "__main__":

    import os
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    try:
        import torch
        if torch.cuda.is_available():
            print("显卡可用 (错误)")
        else:
            print("显卡已禁用，正在使用 CPU (正确)")
    except ImportError:
        print("torch 未安装，跳过 GPU 检测，使用 CPU (正确)")

    main()
