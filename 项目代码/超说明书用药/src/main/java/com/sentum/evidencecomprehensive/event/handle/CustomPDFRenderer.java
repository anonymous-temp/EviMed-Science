package com.sentum.evidencecomprehensive.event.handle;

import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.pdmodel.PDPage;

import java.io.IOException;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/7
 */
@Slf4j
public class CustomPDFRenderer extends PDFStreamEngine {

    public CustomPDFRenderer() throws IOException {
        super(); // 调用无参构造函数

        this.addOperator(new CustomSetFontAndSize(this));
    }

    public void render(PDPage page) throws IOException {
        processPage(page);
    }
}
