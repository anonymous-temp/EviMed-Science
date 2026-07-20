package com.sentum.evidencecomprehensive.event.handle;

import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.contentstream.operator.text.SetFontAndSize;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;

import java.io.IOException;
import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/7
 */
@Slf4j
public class CustomSetFontAndSize extends SetFontAndSize {


    private final PDFStreamEngine engine;

    // 构造函数，接收 PDFStreamEngine 实例
    public CustomSetFontAndSize(PDFStreamEngine engine) {
        this.engine = engine;
    }
    
    @Override
    public void process(Operator operator, List<COSBase> arguments) throws IOException {
        try {
            super.process(operator, arguments);
        } catch (ArrayIndexOutOfBoundsException e) {
            // 记录错误日志
            log.error("字体解析失败，使用默认字体替换", e);

            // 获取字体名称和字号
            COSName fontName = (COSName) arguments.get(0);
            COSNumber fontSizeNumber = (COSNumber) arguments.get(1);
            float fontSize = fontSizeNumber.floatValue();
            
            // 获取当前页面的资源
            PDResources resources = engine.getResources();

            // 尝试获取字体，如果失败则使用默认字体
            PDFont font = resources.getFont(fontName);
            if (font == null) {
                font = PDType1Font.HELVETICA; // 使用默认字体
            }

            // 设置默认字体
            // 设置默认字体
            engine.getGraphicsState().getTextState().setFont(font);
            engine.getGraphicsState().getTextState().setFontSize(fontSize);
        }
    }
}
