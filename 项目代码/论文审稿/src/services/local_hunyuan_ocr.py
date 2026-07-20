"""
Local HunyuanOCR Parser - Using open-source model
Uses locally deployed HunyuanOCR model from GitHub
"""
import os
from pathlib import Path
from typing import Tuple, Dict, Any, Optional
from pdf2image import convert_from_path
from PIL import Image
import io

from .document_parser import DocumentParser


class LocalHunyuanOCRParser(DocumentParser):
    """
    Local HunyuanOCR parser using open-source model.

    Uses the official HunyuanOCR model (1B parameters) deployed locally via vLLM or Transformers.
    Model: https://github.com/Tencent-Hunyuan/HunyuanOCR

    Requirements:
    - Python 3.12+
    - vLLM >= 0.12.0 (recommended) or Transformers
    - 20GB GPU memory
    - Model weights: tencent/HunyuanOCR from Hugging Face
    """

    def __init__(
        self,
        model_name: str = "tencent/HunyuanOCR",
        backend: str = "vllm",  # "vllm" or "transformers"
        device: str = "cuda",
        max_tokens: int = 16384
    ):
        """
        Initialize local HunyuanOCR parser.

        Args:
            model_name: Model identifier on Hugging Face
            backend: Inference backend ("vllm" or "transformers")
            device: Device to run model on ("cuda" or "cpu")
            max_tokens: Maximum tokens for generation
        """
        super().__init__()
        self.model_name = model_name
        self.backend = backend
        self.device = device
        self.max_tokens = max_tokens
        self.model = None
        self.processor = None

        # Lazy load model (only when needed)
        self._model_loaded = False

    def _load_model(self):
        """Load the HunyuanOCR model (lazy loading)"""
        if self._model_loaded:
            return

        try:
            if self.backend == "vllm":
                self._load_vllm_model()
            elif self.backend == "transformers":
                self._load_transformers_model()
            else:
                raise ValueError(f"Unknown backend: {self.backend}. Use 'vllm' or 'transformers'")

            self._model_loaded = True
            print(f"Y HunyuanOCR model loaded successfully ({self.backend})")

        except Exception as e:
            raise RuntimeError(
                f"Failed to load HunyuanOCR model. "
                f"Please ensure model is downloaded and dependencies are installed.\n"
                f"Error: {str(e)}\n"
                f"Installation: pip install vllm>=0.12.0 or pip install transformers"
            )

    def _load_vllm_model(self):
        """Load model using vLLM (recommended for performance)"""
        from vllm import LLM, SamplingParams
        from vllm.utils import FlexibleArgumentParser

        # Initialize vLLM engine
        self.model = LLM(
            model=self.model_name,
            gpu_memory_utilization=0.9,  # Use 90% of GPU memory
            tensor_parallel_size=1,
            dtype="bfloat16",
            trust_remote_code=True
        )

        self.sampling_params = SamplingParams(
            max_tokens=self.max_tokens,
            temperature=0.0,  # Deterministic for OCR
            top_p=1.0
        )

        print(f"Y vLLM engine initialized with {self.model_name}")

    def _load_transformers_model(self):
        """Load model using Transformers (alternative)"""
        from transformers import AutoProcessor, AutoModelForVision2Seq
        import torch

        # Load processor and model
        self.processor = AutoProcessor.from_pretrained(
            self.model_name,
            trust_remote_code=True
        )

        self.model = AutoModelForVision2Seq.from_pretrained(
            self.model_name,
            torch_dtype=torch.bfloat16,
            device_map=self.device,
            trust_remote_code=True
        )

        print(f"Y Transformers model loaded: {self.model_name}")

    def parse(self, file_path: str) -> Tuple[str, Dict[str, Any]]:
        """
        Parse PDF or image using local HunyuanOCR.

        Args:
            file_path: Path to PDF or image file

        Returns:
            Tuple of (extracted_text, metadata)
        """
        file_path = Path(file_path)

        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # Load model on first use
        self._load_model()

        # Determine file type
        if file_path.suffix.lower() == '.pdf':
            return self._parse_pdf(str(file_path))
        elif file_path.suffix.lower() in ['.png', '.jpg', '.jpeg', '.tiff', '.bmp']:
            return self._parse_image(str(file_path))
        else:
            raise ValueError(f"Unsupported file format: {file_path.suffix}")

    def _parse_pdf(self, pdf_path: str) -> Tuple[str, Dict[str, Any]]:
        """Parse PDF by converting to images and running OCR"""
        try:
            # Convert PDF to images (300 DPI for high quality)
            images = convert_from_path(pdf_path, dpi=300)

            all_text = []
            metadata = {
                "total_pages": len(images),
                "parser": "LocalHunyuanOCR",
                "backend": self.backend,
                "model": self.model_name
            }

            # Process each page
            for page_num, image in enumerate(images, 1):
                print(f"  Processing page {page_num}/{len(images)}...")
                page_text = self._ocr_image(image)

                if page_text.strip():
                    all_text.append(f"--- Page {page_num} ---\n{page_text}\n")

            full_text = "\n".join(all_text)
            metadata["total_characters"] = len(full_text)

            return full_text, metadata

        except Exception as e:
            raise RuntimeError(f"PDF parsing failed: {str(e)}")

    def _parse_image(self, image_path: str) -> Tuple[str, Dict[str, Any]]:
        """Parse single image file"""
        try:
            image = Image.open(image_path).convert("RGB")
            text = self._ocr_image(image)

            metadata = {
                "parser": "LocalHunyuanOCR",
                "backend": self.backend,
                "model": self.model_name,
                "image_size": image.size,
                "total_characters": len(text)
            }

            return text, metadata

        except Exception as e:
            raise RuntimeError(f"Image parsing failed: {str(e)}")

    def _ocr_image(self, image: Image.Image) -> str:
        """
        Run OCR on a single image using HunyuanOCR.

        Args:
            image: PIL Image object

        Returns:
            Extracted text
        """
        if self.backend == "vllm":
            return self._ocr_with_vllm(image)
        elif self.backend == "transformers":
            return self._ocr_with_transformers(image)

    def _ocr_with_vllm(self, image: Image.Image) -> str:
        """OCR using vLLM backend"""
        # Prepare prompt for OCR task
        prompt = "Extract all text from this image, preserving layout and structure."

        # Create message with image
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt}
                ]
            }
        ]

        # Run inference
        outputs = self.model.chat(
            messages,
            sampling_params=self.sampling_params
        )

        # Extract text from output
        if outputs and len(outputs) > 0:
            return outputs[0].outputs[0].text.strip()

        return ""

    def _ocr_with_transformers(self, image: Image.Image) -> str:
        """OCR using Transformers backend"""
        import torch

        # Prepare prompt
        prompt = "Extract all text from this image, preserving layout and structure."

        # Create conversation
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt}
                ]
            }
        ]

        # Apply chat template
        text = self.processor.apply_chat_template(
            messages,
            add_generation_prompt=True
        )

        # Process inputs
        inputs = self.processor(
            text=[text],
            images=[image],
            return_tensors="pt"
        ).to(self.device)

        # Generate
        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=self.max_tokens,
                do_sample=False,  # Deterministic
                temperature=None,
                top_p=None
            )

        # Decode output
        generated_ids = [
            output_ids[len(input_ids):]
            for input_ids, output_ids in zip(inputs.input_ids, outputs)
        ]

        output_text = self.processor.batch_decode(
            generated_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )[0]

        return output_text.strip()


def create_ocr_parser(
    use_local: bool = True,
    api_endpoint: Optional[str] = None,
    api_key: Optional[str] = None,
    **kwargs
) -> DocumentParser:
    """
    Factory function to create OCR parser.

    Args:
        use_local: If True, use local HunyuanOCR model (default)
        api_endpoint: API endpoint if using cloud service
        api_key: API key if using cloud service
        **kwargs: Additional arguments for parser

    Returns:
        DocumentParser instance
    """
    if use_local:
        # Default to local open-source model
        return LocalHunyuanOCRParser(**kwargs)
    else:
        # Fall back to API-based parser
        from .ocr_parser import HunyuanOCRParser
        return HunyuanOCRParser(
            api_endpoint=api_endpoint or os.getenv("HUNYUAN_OCR_ENDPOINT"),
            api_key=api_key or os.getenv("HUNYUAN_OCR_API_KEY")
        )
