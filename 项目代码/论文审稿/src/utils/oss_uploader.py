"""
阿里云 OSS 上传工具
将报告文件上传至 OSS，返回可公开访问的 URL。

路径规则：
  {agentType}/{userId}/{messageId}/{timestamp_ms}.md
示例：
  paper-review/5773064745007488920/4cc00a48-9abf-48ee-abea-df362c524728/1772700275927.md
"""
import os
import time
import tempfile
import asyncio
import logging
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

logger = logging.getLogger(__name__)


def _upload_to_oss(content: str, remote_path: str) -> None:
    """同步上传字符串内容到 OSS（在线程中执行，不阻塞事件循环）"""
    import oss2

    access_key_id = os.getenv("OSS_ACCESS_KEY_ID")
    access_key_secret = os.getenv("OSS_ACCESS_KEY_SECRET")
    endpoint = os.getenv("OSS_ENDPOINT", "https://oss-cn-beijing.aliyuncs.com")
    bucket_name = os.getenv("OSS_BUCKET_NAME", "project-beijing-a4hznzutlh")

    auth = oss2.Auth(access_key_id, access_key_secret)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", encoding="utf-8", delete=False
    ) as f:
        f.write(content)
        tmp_path = f.name

    try:
        for attempt in range(3):
            try:
                bucket.put_object_from_file(remote_path, tmp_path)
                logger.info(f"OSS 上传成功: {remote_path}")
                return
            except Exception as e:
                logger.warning(f"OSS 上传失败(attempt {attempt + 1}): {e}")
                if attempt < 2:
                    time.sleep(2)
        raise RuntimeError(f"OSS 上传失败，已重试 3 次: {remote_path}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


async def upload_report(
    content: str,
    user_id: str,
    message_id: str,
    agent_type: str = "paper-review",
) -> Optional[str]:
    """
    异步上传报告到 OSS。

    Args:
        content:    报告 Markdown 内容
        user_id:    用户 ID
        message_id: 本次消息 UUID
        agent_type: 顶层目录名，默认 "paper-review"

    Returns:
        公开访问 URL，上传失败时返回 None
    """
    access_key_id = os.getenv("OSS_ACCESS_KEY_ID")
    access_key_secret = os.getenv("OSS_ACCESS_KEY_SECRET")

    if not access_key_id or not access_key_secret:
        logger.warning("OSS 凭证未配置，跳过上传")
        return None

    base_url = os.getenv("OSS_PUBLIC_BASE_URL", "https://image.evimed.com/oss")
    timestamp_ms = int(time.time() * 1000)
    remote_path = f"{agent_type}/{user_id}/{message_id}/{timestamp_ms}.md"

    try:
        await asyncio.to_thread(_upload_to_oss, content, remote_path)
        url = f"{base_url.rstrip('/')}/{remote_path}"
        return url
    except Exception as e:
        logger.error(f"OSS 上传异常，降级为 base64 返回: {e}")
        return None
