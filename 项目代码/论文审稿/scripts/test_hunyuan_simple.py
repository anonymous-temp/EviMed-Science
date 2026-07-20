#!/usr/bin/env python3
"""
Simple test script for HunyuanOCR integration
Tests both vLLM and Transformers backends
"""
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, ImageDraw, ImageFont
import tempfile


def create_test_image():
    """Create a test image with multilingual text"""
    img = Image.new('RGB', (1000, 600), color='white')
    draw = ImageDraw.Draw(img)

    # Try to load a nice font
    try:
        font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 50)
        font_body = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)
    except:
        font_title = ImageFont.load_default()
        font_body = ImageFont.load_default()

    # Draw test content
    draw.text((50, 50), "HunyuanOCR Test Document", fill='black', font=font_title)
    draw.text((50, 150), "English: The quick brown fox", fill='black', font=font_body)
    draw.text((50, 220), "中文: 快速的棕色狐狸", fill='black', font=font_body)
    draw.text((50, 290), "日本語: 速い茶色のキツネ", fill='black', font=font_body)
    draw.text((50, 360), "한국어: 빠른 갈색 여우", fill='black', font=font_body)
    draw.text((50, 430), "Русский: Быстрая лиса", fill='black', font=font_body)
    draw.text((50, 500), "© 2026 Test Document", fill='gray', font=font_body)

    return img


def test_backend(backend="vllm"):
    """Test a specific backend"""
    print(f"\n{'=' * 70}")
    print(f"Testing HunyuanOCR with {backend.upper()} backend")
    print('=' * 70)

    try:
        from src.services.local_hunyuan_ocr import LocalHunyuanOCRParser

        # Create test image
        print("\n1. Creating test image...")
        test_img = create_test_image()
        print("   ✓ Test image created (1000x600, multilingual text)")

        # Save to temporary file
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
            test_img.save(tmp_path)
            print(f"   ✓ Saved to: {tmp_path}")

        # Initialize parser
        print(f"\n2. Initializing {backend.upper()} parser...")
        print("   (This may take a while on first run - downloading model...)")
        parser = LocalHunyuanOCRParser(backend=backend)
        print(f"   ✓ Parser initialized successfully")

        # Run OCR
        print("\n3. Running OCR...")
        text, metadata = parser.parse(tmp_path)

        # Display results
        print("\n" + "=" * 70)
        print("OCR RESULTS")
        print("=" * 70)
        print("\nExtracted Text:")
        print("-" * 70)
        print(text)
        print("-" * 70)

        print("\nMetadata:")
        for key, value in metadata.items():
            print(f"  • {key}: {value}")

        # Cleanup
        os.unlink(tmp_path)

        print("\n" + "=" * 70)
        print(f"✓ {backend.upper()} backend test PASSED")
        print("=" * 70)

        return True

    except ImportError as e:
        print(f"\n✗ Import error: {e}")
        print(f"\nTo install {backend}:")
        if backend == "vllm":
            print("  pip install vllm>=0.12.0")
        else:
            print("  pip install git+https://github.com/huggingface/transformers@82a06db03535c49aa987719ed0746a76093b1ec4")
        return False

    except Exception as e:
        print(f"\n✗ Test FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main test function"""
    print("\n" + "=" * 70)
    print("HunyuanOCR Integration Test")
    print("=" * 70)
    print("\nThis script will test the local HunyuanOCR integration.")
    print("Model: tencent/HunyuanOCR (1B parameters)")
    print("Source: https://github.com/Tencent-Hunyuan/HunyuanOCR")

    # Check which backends are available
    print("\nChecking available backends...")

    backends_to_test = []

    try:
        import vllm
        print("  ✓ vLLM is installed")
        backends_to_test.append("vllm")
    except ImportError:
        print("  ✗ vLLM not installed (pip install vllm>=0.12.0)")

    try:
        import transformers
        print("  ✓ Transformers is installed")
        backends_to_test.append("transformers")
    except ImportError:
        print("  ✗ Transformers not installed")

    if not backends_to_test:
        print("\n✗ No backends available. Please install vLLM or Transformers.")
        print("\nInstallation:")
        print("  pip install vllm>=0.12.0  # Recommended")
        print("  # OR")
        print("  pip install git+https://github.com/huggingface/transformers@82a06db03535c49aa987719ed0746a76093b1ec4")
        return 1

    # Run tests
    results = {}
    for backend in backends_to_test:
        results[backend] = test_backend(backend)

    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    for backend, success in results.items():
        status = "✓ PASSED" if success else "✗ FAILED"
        print(f"  {backend.upper()}: {status}")

    all_passed = all(results.values())
    if all_passed:
        print("\n✓ All tests passed! HunyuanOCR is ready to use.")
        return 0
    else:
        print("\n✗ Some tests failed. Please check the errors above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
