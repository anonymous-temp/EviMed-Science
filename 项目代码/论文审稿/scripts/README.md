# Scripts Directory

This directory contains helper scripts for system deployment and testing.

## Available Scripts

### 1. `setup_hunyuan_ocr.sh`

**Purpose**: Automated deployment script for HunyuanOCR

**Usage**:
```bash
chmod +x setup_hunyuan_ocr.sh
./setup_hunyuan_ocr.sh
```

**Features**:
- Checks system requirements (Python, CUDA, GPU memory)
- Interactive backend selection (vLLM or Transformers)
- Installs dependencies
- Downloads HunyuanOCR model from Hugging Face
- Creates a test script
- Provides deployment summary

**Requirements**:
- Bash shell
- Python 3.12+
- 20GB GPU memory (recommended)
- Internet connection (for model download)

---

### 2. `test_hunyuan_simple.py`

**Purpose**: Simple test script for HunyuanOCR integration

**Usage**:
```bash
python3 scripts/test_hunyuan_simple.py
```

**Features**:
- Tests both vLLM and Transformers backends
- Creates a multilingual test image
- Runs OCR and displays results
- Provides detailed error messages
- No external dependencies beyond the system

**Test Image Content**:
- English, Chinese, Japanese, Korean, Russian text
- Mixed-language document simulation

**Output Example**:
```
======================================================================
Testing HunyuanOCR with VLLM backend
======================================================================

1. Creating test image...
   ✓ Test image created (1000x600, multilingual text)
   ✓ Saved to: /tmp/tmp_xyz.png

2. Initializing VLLM parser...
   ✓ Parser initialized successfully

3. Running OCR...

======================================================================
OCR RESULTS
======================================================================

Extracted Text:
----------------------------------------------------------------------
HunyuanOCR Test Document
English: The quick brown fox
中文: 快速的棕色狐狸
日本語: 速い茶色のキツネ
한국어: 빠른 갈색 여우
Русский: Быстрая лиса
© 2026 Test Document
----------------------------------------------------------------------

Metadata:
  • parser: LocalHunyuanOCR
  • backend: vllm
  • model: tencent/HunyuanOCR
  • image_size: (1000, 600)
  • total_characters: 156

======================================================================
✓ VLLM backend test PASSED
======================================================================
```

---

## Troubleshooting

### Issue: "No backends available"

**Solution**: Install at least one inference backend

```bash
# Option 1: vLLM (recommended)
pip install vllm>=0.12.0

# Option 2: Transformers
pip install git+https://github.com/huggingface/transformers@82a06db03535c49aa987719ed0746a76093b1ec4
```

### Issue: "CUDA out of memory"

**Solution**: Reduce GPU memory utilization

Edit `src/services/local_hunyuan_ocr.py`:
```python
self.model = LLM(
    model=self.model_name,
    gpu_memory_utilization=0.5,  # Reduce from 0.9 to 0.5
    ...
)
```

### Issue: "Model download failed"

**Solution**: Manual download

```bash
# Download model manually
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('tencent/HunyuanOCR')
"
```

### Issue: "ImportError: No module named 'vllm'"

**Solution**: Install missing dependencies

```bash
pip install vllm>=0.12.0 torch>=2.7.0
```

---

## Additional Resources

- **HunyuanOCR GitHub**: https://github.com/Tencent-Hunyuan/HunyuanOCR
- **Model on Hugging Face**: https://huggingface.co/tencent/HunyuanOCR
- **Official Website**: https://hunyuanocr.org/
- **vLLM Documentation**: https://docs.vllm.ai/

---

## Performance Benchmarks

### OCR Performance
- **OCRBench**: 860 (SOTA for models < 3B parameters)
- **OmniDocBench**: 94.1 (complex document parsing)
- **Language Support**: 100+ languages

### System Requirements
- **Inference Speed**: ~2-3 seconds per page (vLLM, GPU)
- **GPU Memory**: 20GB recommended
- **Model Size**: ~2GB on disk
- **CPU Fallback**: Available but slower (~10x)

---

## Contributing

To add new deployment scripts:

1. Create the script in this directory
2. Add documentation to this README
3. Test on clean environment
4. Submit PR with examples

---

## License

Same as parent project.
