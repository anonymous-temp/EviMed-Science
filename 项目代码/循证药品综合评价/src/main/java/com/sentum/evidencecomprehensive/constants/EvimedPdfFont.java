package com.sentum.evidencecomprehensive.constants;

import com.itextpdf.text.Font;
import com.itextpdf.text.pdf.BaseFont;

public class EvimedPdfFont {
    // 定义全局的字体静态变量

    public static Font TITLE;
    public static Font HEAD;
    public static  Font kEY;
    public static Font SUBHEAD;
    public static  Font SECOND ;
    public static  Font THIRD;
    public static  Font TEXT;


    static {
        BaseFont bfChinese =null;
        try {
            bfChinese= BaseFont.createFont("STSong-Light", "UniGB-UCS2-H", BaseFont.NOT_EMBEDDED);
        }catch (Exception e){
            e.printStackTrace();
        }

        TITLE = new Font(bfChinese, 16, Font.BOLD);
        HEAD = new Font(bfChinese, 14, Font.BOLD);
        kEY = new Font(bfChinese, 10, Font.BOLD);
        SUBHEAD = new Font(bfChinese,14,Font.NORMAL);
        SECOND = new Font(bfChinese,13,Font.NORMAL);
        THIRD = new Font(bfChinese,12,Font.NORMAL);
        TEXT = new Font(bfChinese, 10, Font.NORMAL);

    }
}
