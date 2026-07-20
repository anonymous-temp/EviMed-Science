#!/bin/bash
# Setup script for HunyuanOCR local deployment

set -e

echo "=========================================="
echo "HunyuanOCR 本地部署脚本"
echo "=========================================="
echo ""

# Check Python version
echo "检查 Python 版本..."
python_version=$(python3 --version | awk '{print $2}')
required_version="3.12"

if [ "$(printf '%s\n' "$required_version" "$python_version" | sort -V | head -n1)" != "$required_version" ]; then
    echo "⚠️  警告: Python 版本 $python_version < 3.12"
    echo "   推荐使用 Python 3.12+，但将尝试继续安装..."
else
    echo "✓ Python 版本: $python_version"
fi
echo ""

# Check CUDA
echo "检查 CUDA..."
if command -v nvidia-smi &> /dev/null; then
    cuda_version=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
    gpu_memory=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1)

    echo "✓ CUDA 版本: $cuda_version"
    echo "✓ GPU 显存: ${gpu_memory}MB"

    if [ "$gpu_memory" -lt 20000 ]; then
        echo "⚠️  警告: GPU 显存 < 20GB"
        echo "   推荐至少 20GB 显存，性能可能受限"
    fi
else
    echo "⚠️  未检测到 CUDA/GPU"
    echo "   将使用 CPU 模式（速度较慢）"
fi
echo ""

# Choose backend
echo "选择推理后端:"
echo "  1) vLLM (推荐，性能最佳，需要 GPU)"
echo "  2) Transformers (备选方案，CPU/GPU 均可)"
read -p "请选择 [1/2] (默认: 1): " backend_choice
backend_choice=${backend_choice:-1}
echo ""

if [ "$backend_choice" = "1" ]; then
    BACKEND="vllm"
    echo "已选择: vLLM 后端"
    echo "安装 vLLM..."
    pip install vllm>=0.12.0
else
    BACKEND="transformers"
    echo "已选择: Transformers 后端"
    echo "安装 Transformers..."
    pip install git+https://github.com/huggingface/transformers@82a06db03535c49aa987719ed0746a76093b1ec4
fi
echo ""

# Install common dependencies
echo "安装通用依赖..."
pip install torch>=2.7.0 pdf2image Pillow
echo ""

# Download model
echo "准备下载 HunyuanOCR 模型..."
echo "模型大小: ~2GB"
echo "下载位置: ~/.cache/huggingface/"
read -p "是否继续下载? [y/n] (默认: y): " download_choice
download_choice=${download_choice:-y}

if [ "$download_choice" = "y" ]; then
    echo "开始下载模型..."
    python3 -c "
from huggingface_hub import snapshot_download
print('下载 tencent/HunyuanOCR...')
snapshot_download(
    repo_id='tencent/HunyuanOCR',
    local_dir_use_symlinks=False
)
print('✓ 模型下载完成')
"
else
    echo "跳过下载，模型将在首次使用时自动下载"
fi
echo ""

# Create test script
echo "创建测试脚本..."
cat > test_hunyuan_ocr.py << 'TESTEOF'
#!/usr/bin/env python3
"""Test script for HunyuanOCR"""
import sys
sys.path.insert(0, '.')

from src.services.local_hunyuan_ocr import LocalHunyuanOCRParser
from PIL import Image, ImageDraw, ImageFont
import io

def create_test_image():
    """Create a simple test image with text"""
    img = Image.new('RGB', (800, 400), color='white')
    draw = ImageDraw.Draw(img)

    # Draw test text
    text = "HunyuanOCR Test\n这是一个测试文本\nОCR Тест 테스트"
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
    except:
        font = ImageFont.load_default()

    draw.text((50, 50), text, fill='black', font=font)

    return img

def test_ocr():
    """Test HunyuanOCR"""
    print("=" * 60)
    print("HunyuanOCR 测试")
    print("=" * 60)
    print()

    # Create test image
    print("1. 创建测试图片...")
    test_img = create_test_image()
    print("   ✓ 测试图片已创建")
    print()

    # Initialize parser
    print("2. 初始化 HunyuanOCR 解析器...")
    try:
        parser = LocalHunyuanOCRParser(backend=BACKEND)
        print(f"   ✓ 解析器初始化成功 (backend: {BACKEND})")
    except Exception as e:
        print(f"   ✗ 初始化失败: {e}")
        return False
    print()

    # Save test image temporarily
    print("3. 保存测试图片...")
    test_img.save('/tmp/test_ocr.png')
    print("   ✓ 图片已保存到 /tmp/test_ocr.png")
    print()

    # Run OCR
    print("4. 执行 OCR 识别...")
    try:
        text, metadata = parser.parse('/tmp/test_ocr.png')
        print("   ✓ OCR 识别成功")
        print()
        print("识别结果:")
        print("-" * 60)
        print(text)
        print("-" * 60)
        print()
        print("元数据:")
        for key, value in metadata.items():
            print(f"  - {key}: {value}")
        print()
        print("=" * 60)
        print("✓ HunyuanOCR 测试成功!")
        print("=" * 60)
        return True

    except Exception as e:
        print(f"   ✗ OCR 识别失败: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    BACKEND = "BACKEND_PLACEHOLDER"
    success = test_ocr()
    sys.exit(0 if success else 1)
TESTEOF

# Replace backend placeholder
sed -i "s/BACKEND_PLACEHOLDER/$BACKEND/g" test_hunyuan_ocr.py
chmod +x test_hunyuan_ocr.py

echo "✓ 测试脚本已创建: test_hunyuan_ocr.py"
echo ""

# Summary
echo "=========================================="
echo "安装完成!"
echo "=========================================="
echo ""
echo "后端: $BACKEND"
echo "模型: tencent/HunyuanOCR"
echo ""
echo "测试命令:"
echo "  python3 test_hunyuan_ocr.py"
echo ""
echo "使用示例:"
echo "  from src.services.local_hunyuan_ocr import LocalHunyuanOCRParser"
echo "  parser = LocalHunyuanOCRParser(backend='$BACKEND')"
echo "  text, metadata = parser.parse('document.pdf')"
echo ""
echo "=========================================="
