"""
Enhanced Document Parser with HunyuanOCR support
Supports OCR for scanned PDFs and images
"""
import os
from typing import Optional, Tuple, Dict, Any
from pathlib import Path
import tempfile
import base64

try:
    from pdf2image import convert_from_path
    PDF2IMAGE_AVAILABLE = True
except ImportError:
    PDF2IMAGE_AVAILABLE = False

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

from .document_parser import DocumentParser


class HunyuanOCRParser(DocumentParser):
    """
    Enhanced document parser with HunyuanOCR support for scanned PDFs and images.

    HunyuanOCR is Tencent's high-accuracy OCR service for document recognition.
    Falls back to standard parsing for text-based PDFs.
    """

    def __init__(self,
                 hunyuan_api_key: str = None,
                 hunyuan_endpoint: str = None,
                 use_ocr_fallback: bool = True):
        """
        Initialize enhanced parser with HunyuanOCR.

        Args:
            hunyuan_api_key: API key for HunyuanOCR service
            hunyuan_endpoint: API endpoint (defaults to official endpoint)
            use_ocr_fallback: Use OCR if standard text extraction fails
        """
        super().__init__()

        self.hunyuan_api_key = hunyuan_api_key or os.getenv('HUNYUAN_API_KEY')
        self.hunyuan_endpoint = hunyuan_endpoint or os.getenv(
            'HUNYUAN_ENDPOINT',
            'https://ocr.tencentcloudapi.com'
        )
        self.use_ocr_fallback = use_ocr_fallback

    def parse(self, file_path: str) -> Tuple[str, dict]:
        """
        Parse document with OCR fallback for scanned PDFs.

        Args:
            file_path: Path to the manuscript file

        Returns:
            Tuple of (text_content, metadata)
        """
        # First, try standard parsing
        try:
            text, metadata = super().parse(file_path)

            # Check if text extraction was successful
            word_count = len(text.split())

            # If we got very little text, it might be a scanned PDF
            if word_count < 100 and self.use_ocr_fallback:
                file_ext = Path(file_path).suffix.lower()

                if file_ext == '.pdf':
                    print(f"Low word count ({word_count}), attempting OCR extraction...")
                    ocr_text, ocr_metadata = self._parse_with_ocr(file_path)

                    if len(ocr_text.split()) > word_count:
                        print(f"OCR extraction successful: {len(ocr_text.split())} words")
                        metadata.update(ocr_metadata)
                        metadata['extraction_method'] = 'hunyuan_ocr'
                        return ocr_text, metadata

            metadata['extraction_method'] = 'standard'
            return text, metadata

        except Exception as e:
            # If standard parsing fails completely, try OCR
            if self.use_ocr_fallback:
                print(f"Standard parsing failed ({str(e)}), attempting OCR...")
                return self._parse_with_ocr(file_path)
            raise

    def _parse_with_ocr(self, file_path: str) -> Tuple[str, dict]:
        """
        Parse PDF using HunyuanOCR for scanned documents.

        Args:
            file_path: Path to PDF file

        Returns:
            Tuple of (ocr_text, metadata)
        """
        if not self.hunyuan_api_key:
            raise ValueError(
                "HunyuanOCR API key not configured. "
                "Set HUNYUAN_API_KEY environment variable or pass api_key parameter."
            )

        if not PDF2IMAGE_AVAILABLE:
            raise ImportError(
                "pdf2image not installed. Run: pip install pdf2image\n"
                "Also requires poppler: sudo apt-get install poppler-utils (Linux) "
                "or brew install poppler (Mac)"
            )

        # Convert PDF pages to images
        print(f"Converting PDF to images for OCR...")
        images = convert_from_path(file_path, dpi=300)

        all_text = []
        metadata = {
            'page_count': len(images),
            'ocr_service': 'hunyuan',
            'extraction_method': 'ocr'
        }

        # Process each page
        for page_num, image in enumerate(images, 1):
            print(f"Processing page {page_num}/{len(images)} with OCR...")

            # Save image to temp file
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp_file:
                image.save(tmp_file.name, 'PNG')
                tmp_path = tmp_file.name

            try:
                # Perform OCR on this page
                page_text = self._ocr_image(tmp_path)
                all_text.append(page_text)
            finally:
                # Clean up temp file
                os.unlink(tmp_path)

        # Combine all pages
        full_text = '\n\n--- Page Break ---\n\n'.join(all_text)

        return full_text, metadata

    def _ocr_image(self, image_path: str) -> str:
        """
        Perform OCR on a single image using HunyuanOCR API.

        Args:
            image_path: Path to image file

        Returns:
            Extracted text from image
        """
        if not REQUESTS_AVAILABLE:
            raise ImportError("requests not installed. Run: pip install requests")

        # Read and encode image
        with open(image_path, 'rb') as f:
            image_data = f.read()
            image_base64 = base64.b64encode(image_data).decode('utf-8')

        # Prepare API request
        # Note: This is a simplified example. Actual HunyuanOCR API may have different format
        # Adjust based on official API documentation
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.hunyuan_api_key}'
        }

        payload = {
            'ImageBase64': image_base64,
            'LanguageType': 'auto',  # Auto-detect language
            'IsPdf': False,
            'EnableDetectText': True
        }

        try:
            response = requests.post(
                f'{self.hunyuan_endpoint}/ocr/general',
                json=payload,
                headers=headers,
                timeout=30
            )
            response.raise_for_status()

            result = response.json()

            # Extract text from response
            # Note: Adjust based on actual API response format
            if 'TextDetections' in result:
                texts = [item['DetectedText'] for item in result['TextDetections']]
                return '\n'.join(texts)
            elif 'text' in result:
                return result['text']
            else:
                print(f"Unexpected OCR response format: {result}")
                return ""

        except requests.exceptions.RequestException as e:
            print(f"HunyuanOCR API error: {str(e)}")
            # Fallback to simple extraction message
            return "[OCR extraction failed for this page]"

    def parse_image(self, image_path: str) -> Tuple[str, dict]:
        """
        Parse an image file directly using OCR.

        Args:
            image_path: Path to image file (jpg, png, etc.)

        Returns:
            Tuple of (ocr_text, metadata)
        """
        if not self.hunyuan_api_key:
            raise ValueError("HunyuanOCR API key not configured")

        text = self._ocr_image(image_path)

        metadata = {
            'format': Path(image_path).suffix,
            'extraction_method': 'hunyuan_ocr',
            'file_path': image_path
        }

        return text, metadata


def create_parser(use_ocr: bool = True, **kwargs) -> DocumentParser:
    """
    Factory function to create appropriate parser.

    Args:
        use_ocr: Whether to enable OCR support
        **kwargs: Additional arguments for HunyuanOCRParser

    Returns:
        DocumentParser or HunyuanOCRParser instance
    """
    if use_ocr:
        return HunyuanOCRParser(**kwargs)
    else:
        return DocumentParser()
