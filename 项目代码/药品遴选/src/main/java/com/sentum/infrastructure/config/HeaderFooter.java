package com.sentum.infrastructure.config;

import com.lowagie.text.Document;
import com.lowagie.text.DocumentException;
import com.lowagie.text.Image;
import com.lowagie.text.pdf.PdfPageEventHelper;
import com.lowagie.text.pdf.PdfWriter;

import java.io.IOException;

public class HeaderFooter extends PdfPageEventHelper {
    private Image logo;

    public HeaderFooter(String imagePath) throws IOException, DocumentException {
        logo = Image.getInstance(imagePath);
        logo.scalePercent(50); // 缩放图片到50%
    }

    @Override
    public void onEndPage(PdfWriter writer, Document document) {
        // 计算图片的位置
        float x = document.right() - logo.getScaledWidth();
        float y = document.top();

        // 将图片添加到页面的右上角
        logo.setAbsolutePosition(x, y);
        try {
            writer.getDirectContent().addImage(logo);
        } catch (DocumentException e) {
            throw new RuntimeException(e);
        }
    }
}
