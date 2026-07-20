"""
FastAPI REST API for medical review microservice
"""


import os

# 必须在导入 torch 或 tensorflow 之前设置
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

try:
    import torch
    if torch.cuda.is_available():
        print("显卡可用 (错误)")
    else:
        print("显卡已禁用，正在使用 CPU (正确)")
except ImportError:
    pass
