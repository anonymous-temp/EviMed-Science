package com.sentum.evidencecomprehensive.utils.operateyl;

import cn.hutool.core.util.StrUtil;
import com.google.common.collect.Lists;
import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ClassPathResource;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.List;
import java.util.Objects;

/**
 * Description: 生成图片
 */
@Slf4j
public class PrescriptionPictureGenerateUtils {

    /**
     * 签名图片最大宽度
     */
    private static final int SIGNAL_MAX_WIDTH = 100;

    /**
     * 签名图片最大高度
     */
    private static final int SIGNAL_MAX_HEIGHT = 60;
    
    /**
     * 图片宽
     */
    private static final int PIC_WIDTH = 500;

    /**
     * 图片高
     */
    private static final int PIC_HEIGHT = 400;

    /**
     * 顶部与底部留白
     */
    private static final int MARGIN_Y = 50;

    /**
     * 左右留白
     */
    private static final int MARGIN_X = 60;

    /**
     * 行高
     */
    private static final int LINE_HEIGHT = 10;

    /**
     * 处方笺图片字体
     */
    private static final String FONT_NAME = "方正兰亭黑简体";

    /**
     * 画布一行设置列数
     */
    private static final int COLUMNS = 24;

    /**
     * 标题字体大小
     */
    public static final int FONT_SIZE_TITLE = 20;

    public static final int FONT_SIZE_TITLE_12 = 8;

    /**
     * 正文字体大小
     */
    public static final int FONT_SIZE_BODY_16 = 16;

    /**
     * 正文字体大小
     */
    public static final int FONT_SIZE_BODY_8 = 12;

    /**
     * Rp字体大小
     */
    public static final int FONT_SIZE_RP = 25;


    /**
     * 生成图片后缀
     */
    private static final String file_suffix = "jpg";


    /**
     * 处方笺字体存放路径
     */
    private static final String FONT_LOCATION = "font/fzlthjw.ttf";

    /**
     * 图片绘制使用字体
     */
    private static Font FONT;

    static {
        InputStream inputStream = null;
        try {
            ClassPathResource resource = new ClassPathResource(FONT_LOCATION);
            inputStream = resource.getInputStream();
            FONT = Font.createFont(Font.TRUETYPE_FONT, inputStream);
        } catch (Exception e) {
            log.error("加载自定义字体<{}>失败", FONT_LOCATION, e);
            FONT = new Font(FONT_NAME, Font.PLAIN, 15);
        } finally {
            if (inputStream != null) {
                try {
                    inputStream.close();
                } catch (Exception e) {
                }
            }
        }
    }

    @Getter
    @Setter
    public static class Margin {
        /**
         * 上
         */
        private int top;

        /**
         * 底
         */
        private int bottom;

        /**
         * 左
         */
        private int left;

        /**
         * 右
         */
        private int right;

        public Margin(int top, int bottom, int left, int right) {
            this.top = top;
            this.bottom = bottom;
            this.left = left;
            this.right = right;
        }
    }

    @Getter
    @Setter
    public static class Point {
        /**
         * X
         */
        private int x;

        /**
         * Y
         */
        private int y;

        public Point(int x, int y) {
            this.x = x;
            this.y = y;
        }

        public void offsetY(int offsetY, boolean negative) {
            if (negative) {
                this.y -= offsetY;
            } else {
                this.y += offsetY;
            }
        }

        public void offsetX(int offsetX) {
            this.x += offsetX;
        }
    }

    /**
     * 新建图片
     *
     * @param width     图片宽
     * @param height    图片高
     * @param imageType 图片类型
     * @return 图片实体
     * @Comment comment by liming.wang 2020/11/24 16:30
     */
    private static BufferedImage createImage(int width, int height, int imageType) {
        // 新建图片
        return new BufferedImage(width, height, imageType);
    }

    /**
     * 绘制背景
     *
     * @param image    画布
     * @param graphics 画笔
     * @param bgColor  背景颜色
     * @Comment comment by liming.wang 2020/11/24 16:30
     */
    private static void fillBackground(BufferedImage image, Graphics graphics, Color bgColor) {
        int width = image.getWidth();
        int height = image.getHeight();
        graphics.setClip(0, 0, width, height);
        // 设置画笔颜色
        graphics.setColor(bgColor);
        // 绘制背景
        graphics.fillRect(0, 0, width, height);
    }

    /**
     * 设置画笔颜色和字样
     *
     * @param graphics  画笔
     * @param color     颜色
     * @param fontSize  字体大小
     * @param fontStyle 字体类型
     * @Comment comment by liming.wang 2020/11/25 8:41
     */
    private static void setGraphics(Graphics2D graphics, Color color,
                                    int fontSize, int fontStyle) {
        graphics.setFont(FONT.deriveFont(fontStyle, fontSize));
        //消除文字锯齿
        graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        graphics.setColor(color);
    }

    /**
     * 绘制空行
     *
     * @param point    坐标
     * @param number   空行数
     * @param negative 是否从底部开始绘制
     * @Comment comment by liming.wang 2020/11/24 19:01
     */
    private static void drawBlankLine(Point point, int number, boolean negative) {
        point.offsetY(number * LINE_HEIGHT, negative);
    }
    
    
     
    // ####################################  竖水平线 水平线  #################################

    /**
     * 画水平线
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param margin   间距
     * @param negative 是否从底部开始绘制
     * @Comment comment by liming.wang 2020/11/25 8:40
     */
    private static void drawHorizontalLine(BufferedImage image, Graphics graphics,
                                           Point point, Margin margin, boolean negative) {
        int x = point.getX();
        int y = point.getY();
        int x2 = image.getWidth() - margin.getRight();
        graphics.drawLine(x, y, x2, y);
    }

    /**
     * 画水平线
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param margin   间距
     * @param negative 是否从底部开始绘制
     * @Comment comment by liming.wang 2020/11/25 8:40
     */
    private static void drawHorizontalLineByDesign(BufferedImage image, 
                                                   Graphics graphics,
                                                   Point point, 
                                                   int increment_Y,
                                                   Margin margin, 
                                                   boolean negative) {
        int x = point.getX();
        int y = point.getY();

        int width = image.getWidth() - (margin.getLeft() + margin.getRight());
        int x1 = x + width / 2 + 15;
        int y1 = y + LINE_HEIGHT * 2;
        int x2 = x + width + margin.getRight() - 15;
        int y2 = y + increment_Y - LINE_HEIGHT * 2;

        graphics.drawLine(x1, y1, x2, y1);
        graphics.drawLine(x1, y2, x2, y2);
        drawDoubleVerticalLine(graphics, x1, y1, x2, y2);
    }

    /**
     * 画水平线
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param heightWidth    可使用的高度
     * @param margin   间距
//     * @param negative 是否从底部开始绘制
     * @param content
     * @Comment comment by liming.wang 2020/11/25 8:40
     */
    private static void drawTableByDesign(BufferedImage image,
                                                   Graphics graphics,
                                                   Point point,
                                                   int begin_x,
                                                   int begin_y,
                                                   int heightWidth,
                                                   int height,
                                                   Margin margin, 
                                                   Layout[] content) {
        // 画布内容宽度
        int width = image.getWidth() - (margin.getLeft() + margin.getRight());
        int x1 = (begin_x + width / 2);

        Point newPoint = new Point(x1, begin_y);
        for (Layout layout : content) {
            drawTable(image, graphics, newPoint, LINE_HEIGHT, height, margin, false, layout);
        }
//        graphics.drawLine(x, y, x2, y);
//        int height = (int) (graphics.getFontMetrics().getLineMetrics("", graphics).getHeight());
//        point.offsetY(LINE_HEIGHT + height, negative);
    }

    /**
     * 画左右对称两条竖水平线
     *
     * @param graphics 画笔
     */
    private static void drawDoubleVerticalLine(Graphics graphics, 
                                         int x1,
                                         int y1,
                                         int x2,
                                         int y2) {
       
        graphics.drawLine(x1, y1, x1, y2);
        graphics.drawLine(x2, y1, x2, y2);
    }

    /**
     * 画竖水平线
     *  @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param margin   间距
     * @param align 起点位置
     */
    private static void drawVerticalLineCenter(BufferedImage image,
                                         Graphics graphics,
                                         Point point,
                                         int increment_Y,
                                         Margin margin,
                                         Align align) {
        int x = point.getX();
        int y = point.getY();
        
        int width = image.getWidth() - (margin.getLeft() + margin.getRight());

        int tempX = x;
        if (Objects.nonNull(align)) {
            if (align == Align.CENTER) tempX += width / 2;
            graphics.drawLine(tempX, y, tempX, y + increment_Y);
        }
    }
    

    /**
     * 画下水平线
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param margin   间距
     * @param negative 是否从底部开始绘制
     * @Comment comment by liming.wang 2020/11/25 8:40
     */
    private static void drawDownHorizontalLine(BufferedImage image, Graphics graphics,
                                               Point point, Margin margin, boolean negative) {
        int height = (int) (graphics.getFontMetrics().getLineMetrics("", graphics).getHeight());
        int x = point.getX();
        int y = point.getY();
        y = (y - height + LINE_HEIGHT / 2);
        int x2 = image.getWidth() - margin.getRight();
        graphics.drawLine(x, y, x2, y);
        point.offsetY(LINE_HEIGHT + height, negative);
    }

    /**
     * 拆分绘制内容
     *
     * @param graphics 画笔
     * @param content  绘制内容
     * @param width    可用宽度
     * @return 拆分后内容
     * @Comment comment by liming.wang 2020/11/25 10:39
     */
    private static List<String> splitContent(Graphics graphics, String content, int width) {
        int realWidth = width - LINE_HEIGHT;
        int tempWidth = 0;
        FontMetrics fontMetrics = graphics.getFontMetrics();
        List<String> contents = Lists.newLinkedList();
        StringBuilder sb = new StringBuilder();
        for (int index = 0; index < content.length(); index++) {
            String ch = content.charAt(index) + "";
            Rectangle2D rectangle2D = fontMetrics.getStringBounds(ch, graphics);
            int chWidth = (int) rectangle2D.getWidth();
            tempWidth += chWidth;
            if (tempWidth >= realWidth) {
                tempWidth = 0;
                contents.add(sb.toString());
                sb = new StringBuilder(ch);
                continue;
            }
            sb.append(ch);
        }
        if (StrUtil.isNotBlank(sb.toString())) { contents.add(sb.toString()); }
        return contents;
    }

    /**
     * 绘制图片内容
     *
     * @param graphics 画笔
     * @param point    绘制开始坐标
     * @param layout   内容布局
     */
    private static void drawImage(Graphics graphics, Point point, Layout layout) {
        BufferedImage image = layout.getImage();
        if (image == null) { return; }
        int width = SIGNAL_MAX_WIDTH;
        int height = SIGNAL_MAX_HEIGHT;
        graphics.drawImage(image.getScaledInstance(width, height, Image.SCALE_SMOOTH), point.getX(), point.getY() - height / 2, width, height, Color.RED, null);
    }

    /**
     * 绘制处方内容
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param increment_Y  内容增量y
     * @param margin   间隔
     * @param layouts  内容布局
     * @Comment comment by liming.wang 2020/11/25 8:41
     */
    private static void drawString(BufferedImage image, 
                                   Graphics graphics,
                                   Point point, 
                                   int increment_Y,
                                   Margin margin, 
                                   boolean negative,
                                   Layout... layouts) {
        // 内容为空
        if (layouts == null || layouts.length <= 0) { return; }
        // 画布的宽
        int width = image.getWidth() - (margin.getLeft() + margin.getRight());
        int x = point.getX();
        int offsetY = 0;
        for (Layout layout : layouts) {
            String content = layout.getContent();
            if (StrUtil.isBlank(content)) { content = "";}
            Integer col = layout.getCol();
            if (col == null || col < 0) { continue; }
            int colWidth = (col * width) / COLUMNS;
            Rectangle2D rectangle2D = graphics.getFontMetrics().getStringBounds(content, graphics);
            int layoutHeight = (int) rectangle2D.getHeight();
            int layoutWidth = (int) rectangle2D.getWidth();
            // 不需要换行
            Align align = layout.getAlign();
            if (colWidth > layoutWidth) {
                if (StrUtil.isNotBlank(content)) {
                    int tempX = x;
                    if (align == Align.CENTER) { tempX += (colWidth - layoutWidth) / 2; }
                    if (align == Align.RIGHT) { tempX += (colWidth - layoutWidth); }
                    graphics.drawString(content, tempX, point.getY() + increment_Y + layoutHeight / 2);
                } else if (layout.getImage() != null) {
                    Point newPoint = new Point(x, point.getY());
                    drawImage(graphics, newPoint, layout);
                }
                if (offsetY == 0) { offsetY = point.getY() + layoutHeight / 2 + increment_Y * 2; }
            }
            // 需要换行
            else {
                List<String> contentList = splitContent(graphics, content, colWidth);
                Point newPoint = new Point(x, point.getY());
                contentList.forEach(item -> {
                    Layout tempLayout = new Layout(item, align, layout.getCol());
                    drawString(image, graphics, newPoint, LINE_HEIGHT, margin, negative, tempLayout);
                });
                if (newPoint.getY() > offsetY) { offsetY = newPoint.getY(); }
            }
            x += colWidth;
        }
        // 设置Y
        point.offsetY(offsetY - point.getY(), negative);
    }

    /**
     * 绘制
     *
     * @param image    画布
     * @param graphics 画笔
     * @param point    坐标
     * @param increment_Y  内容增量y
     * @param margin   间隔
     * @param layouts  内容布局
     * @Comment comment by liming.wang 2020/11/25 8:41
     */
    private static void drawTable(BufferedImage image,
                                   Graphics graphics,
                                   Point point,
                                   int increment_Y,
                                   int height,
                                   Margin margin,
                                   boolean negative,
                                   Layout... layouts) {
        // 内容为空
        if (layouts == null || layouts.length <= 0) { return; }
        // 画布的宽
        int width = image.getWidth() - (margin.getLeft() + margin.getRight());
        int x = point.getX();
        int offsetY = 0;
        for (Layout layout : layouts) {
            String content = layout.getContent();
            if (StrUtil.isBlank(content)) { content = ""; }
            Integer col = layout.getCol();
            if (col == null || col < 0) { continue; }
//            int colWidth = (col * width) / COLUMNS;
            int colWidth = image.getWidth() - x;
            Rectangle2D rectangle2D = graphics.getFontMetrics().getStringBounds(content, graphics);
            int layoutHeight = (int) rectangle2D.getHeight();
            int layoutWidth = (int) rectangle2D.getWidth();
            // 不需要换行
            Align align = layout.getAlign();
            if (StrUtil.isNotBlank(content)) {
                int tempX = x;
                if (align == Align.CENTER) { tempX += (colWidth - layoutWidth) / 2; }
                if (align == Align.RIGHT) { tempX += (colWidth - layoutWidth); }
                graphics.drawString(content, tempX, point.getY() + increment_Y + height / 2);
            } 
            if (offsetY == 0) { offsetY = point.getY() + height / 2 + increment_Y ;}
            x += colWidth;
        }
        // 设置Y
        point.offsetY(offsetY - point.getY(), negative);
    }

//    public static void main(String[] args) {
//        try {
//            String content1 = "通过EviMed文献数据库检索获得相关文献（n=XX）";
//            String content2 = "阅读题目和摘要初筛（n=XX）";
//            String content3 = "纳入文献（n=XX）";
//            List<String> content4 = new ArrayList<>(Arrays.asList("" +
//                            "剔除重复文献（n=XX）",
//                            "剔除残缺文献（n=XX）",
//                            "剔除残缺文献（n=XX）",
//                            "排除动物实验文献（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
//                            "排除系统性综述（Review）（n=XX）",
//                            "排除系统性综述（Review）（n=XX）",
//                            "排除系统性综述（Review）（n=XX）"
//            ));
//            List<String> content5 = new ArrayList<>(Arrays.asList("" +
//                            "剔除重复文献（n=XX）",
//                    "剔除残缺文献（n=XX）",
//                    "剔除残缺文献（n=XX）",
//                    "排除动物实验文献（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
////                            "排除系统性综述（Review）（n=XX）",
//                    "排除系统性综述（Review）（n=XX）",
//                    "排除系统性综述（Review）（n=XX）",
//                    "排除系统性综述（Review）（n=XX）"
//            ));
//            createImage1(content1, content2, content3, content4, content5, reportImagePath, null);
//        } catch (IOException e) {
//            e.printStackTrace();
//        }
//    }


    public static InputStream createImage(String content1, String content2, String content3, List<String> content4, List<String> content5) throws IOException {
        // 新建图片 高1000 宽 1000
        BufferedImage image = createImage(PIC_WIDTH, PIC_HEIGHT, BufferedImage.TYPE_INT_BGR);
        // 创建画笔
        Graphics2D graphics = image.createGraphics();
        // 初始化背景色
        fillBackground(image, graphics, Color.WHITE);
        // 定义margin 左右留白60 上下留白20 
        Margin margin = new Margin(MARGIN_Y, MARGIN_Y, MARGIN_X, MARGIN_X);
        // 初始化起点坐标 300,200
        Point point = new Point(margin.getLeft(), margin.getTop());
        // 绘制空行
//        drawBlankLine(point, 1, false);
        // 设置画笔
        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY_8, Font.PLAIN);

        // 第一个框框
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);
        int x1 = point.getX();
        int y1 = point.getY();
        drawString(image, graphics, point, 2* LINE_HEIGHT, margin, false, new Layout(content1, Align.CENTER, COLUMNS));
        int width = image.getWidth() - (margin.getLeft() + margin.getRight());
        // 绘制左右对称竖线水平线
        drawDoubleVerticalLine(graphics, x1, y1, x1 + width, y1 + 50);
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);
        // 单竖线
        int height = (int) graphics.getFontMetrics().getStringBounds("", graphics).getHeight();
        int increment_y = (LINE_HEIGHT + height / 2) * (content4.size() + 3); // 根据内容动态变化 基础是 1 * (2 * LINE_HEIGHT + height /2)
        drawVerticalLineCenter(image, graphics, point,increment_y, margin, Align.CENTER);

        // todo 记录
        int x10 = point.getX();
        int y10 = point.getY();

        // 第二个框框
        point.offsetY(increment_y, false);
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);
        int x2 = point.getX();
        int y2 = point.getY();
        drawString(image, graphics, point, 2* LINE_HEIGHT, margin, false, new Layout(content2, Align.CENTER, COLUMNS));
        // 绘制左右对称竖线水平线
        drawDoubleVerticalLine(graphics, x2, y2, x2 + width, y2 + 50);
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);
        // 单竖线
//        drawVerticalLineCenter(image, graphics, point,10 * LINE_HEIGHT, margin, Align.CENTER);
        drawVerticalLineCenter(image, graphics, point,5 * LINE_HEIGHT, margin, Align.CENTER);

        int x20 = point.getX();
        int y20 = point.getY();
        
        // todo 记录  右边第一个框框
        int x11 = point.getX();
        int y11 = point.getY();
        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY_8, Font.PLAIN);
        // 绘制水平线
        Point newPoint = new Point(x10, y10);  //FONT_SIZE_BODY_8
//        drawHorizontalLineByDesign(image, graphics, newPoint, increment_y - (LINE_HEIGHT + height /2), margin, false);
        drawHorizontalLineByDesign(image, graphics, newPoint, increment_y, margin, false);
        // 绘制右边框
        drawTableByDesign(image, graphics, point, x10, y10 + (LINE_HEIGHT + height / 2), y11-y10, height, margin, content(content4));

        //
        // 第三个框框
        point.offsetY(5 * LINE_HEIGHT, false);
        // 设置画笔
        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY_8, Font.PLAIN);
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);
        int x3 = point.getX();
        int y3 = point.getY();
        drawString(image, graphics, point, 2* LINE_HEIGHT, margin, false, new Layout(content3, Align.CENTER, COLUMNS));
        // 绘制左右对称竖线水平线
        drawDoubleVerticalLine(graphics, x3, y3, x3 + width, y3 + 50);
        // 绘制水平线
        drawHorizontalLine(image, graphics, point, margin, false);


//        // todo 记录  右边第二个框框
//        int x21 = point.getX();
//        int y21 = point.getY();
//        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY_8, Font.PLAIN);
//        // 绘制水平线
//        Point newPoint2 = new Point(x20, y20);  //FONT_SIZE_BODY_8
////        drawHorizontalLineByDesign(image, graphics, newPoint, increment_y - (LINE_HEIGHT + height /2), margin, false);
//        drawHorizontalLineByDesign(image, graphics, newPoint2, increment_y, margin, false);
//        // 绘制右边框
//        drawTableByDesign(image, graphics, point, x20, y20 + (LINE_HEIGHT + height / 2), y21-y20, height, margin, content(content5));


        // 绘制底层表名
        // 设置画笔
        setGraphics(graphics, Color.BLACK, FONT_SIZE_TITLE_12, Font.BOLD);
        // 绘制空行
        drawBlankLine(point, 2, false);
        String tableName = "文献纳入排除 PRISMA 流程图";
        drawString(image, graphics, point, LINE_HEIGHT, margin, false, new Layout(tableName, Align.CENTER, COLUMNS));
        
//        // 底部签名信息
//        drawString(image, graphics, point, margin, true, signLayouts());
//        // 底部横线
//        drawHorizontalLine(image, graphics, point, margin, true);
//        // 设置画笔
//        setGraphics(graphics, Color.RED, FONT_SIZE_BODY, Font.PLAIN);
        // 销毁画笔，结束绘制
        graphics.dispose();
        return imageInputStream(image);
    }    
    
    private static Layout[] content(List<String> content4) {
        int size = content4.size();
        Layout[] layouts = new Layout[size];
        for (int i = 0; i < content4.size(); i++) {
            layouts[i] = new Layout(content4.get(i), Align.CENTER, 20);
        }
        return layouts;
    }
    
    /**
     * 生成处方图片
     *
//     * @param prescriptionInfo      图片文本所需内容
//     * @param doctorSignPicture     医生签名
//     * @param pharmacistSignPicture 药师签名
     * @return java.io.InputStream
     * @author liu.zr 2020/11/23 13:57
     */
//    public static InputStream createImage(PrescriptionInfoDTO prescriptionInfo, BufferedImage doctorSignPicture, BufferedImage pharmacistSignPicture) throws Exception {
//        // 新建图片
//        BufferedImage image = createImage(PIC_WIDTH, PIC_HEIGHT, BufferedImage.TYPE_INT_BGR);
//        // 创建画笔
//        Graphics2D graphics = image.createGraphics();
//
//        // 初始化背景色
//        fillBackground(image, graphics, Color.WHITE);
//        // 定义margin
//        Margin margin = new Margin(MARGIN_Y, MARGIN_Y, MARGIN_X, MARGIN_X);
//        // 初始化坐标
//        Point point = new Point(margin.getLeft(), margin.getTop());
//
//        // 绘制空行
//        drawBlankLine(point, 5, false);
//        // 设置画笔
//        setGraphics(graphics, Color.BLACK, FONT_SIZE_TITLE, Font.BOLD);
//        // 绘制处方title
//        String content = prescriptionInfo.getChainName() + "  处方笺";
//        drawString(image, graphics, point, margin, false,
//                new Layout(content, Align.CENTER, COLUMNS));
//        // 绘制空行
//        drawBlankLine(point, 3, false);
//
//        // 设置画笔
//        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY, Font.PLAIN);
//        // 绘制横线
//        drawHorizontalLine(image, graphics, point, margin, false);
//        // 绘制病例，科室，日期
//        List<Layout> layouts = Lists.newLinkedList();
//        layouts.add(new Layout("病历号：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getCode(), Align.LEFT, 5));
//        layouts.add(new Layout("科室：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getDepartmentName(), Align.LEFT, 5));
//        layouts.add(new Layout("开具日期：", Align.RIGHT, 3));
//        String dateStr = DateUtil.format(prescriptionInfo.getCfDate(), DatePattern.NORM_DATE_PATTERN);
//        layouts.add(new Layout(dateStr, Align.LEFT, 5));
//        drawString(image, graphics, point, margin, false, layouts.toArray(new Layout[6]));
//        layouts.clear();
//
//        // 绘制姓名，性别，年龄
//        layouts.add(new Layout("姓名：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getName(), Align.LEFT, 5));
//        layouts.add(new Layout("性别：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getSex(), Align.LEFT, 5));
//        layouts.add(new Layout("年龄：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getAge(), Align.LEFT, 5));
//        drawString(image, graphics, point, margin, false, layouts.toArray(new Layout[6]));
//        layouts.clear();
//
//        // 绘制诊断
//        layouts.add(new Layout("诊断：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getDiagnosis(), Align.LEFT, 21));
//        drawString(image, graphics, point, margin, false, layouts.toArray(new Layout[2]));
//        layouts.clear();
//        // 绘制横线
//        drawDownHorizontalLine(image, graphics, point, margin, false);
//
//        // 设置画笔
//        setGraphics(graphics, Color.BLACK, FONT_SIZE_RP, Font.BOLD);
//        // 绘制空行
//        drawBlankLine(point, 3, false);
//        // 绘制Rp
//        drawString(image, graphics, point, margin, false,
//                new Layout("Rp", Align.LEFT, COLUMNS));
//        // 绘制空行
//        drawBlankLine(point, 2, false);
//
//        // 设置画笔
//        setGraphics(graphics, Color.BLACK, FONT_SIZE_BODY, Font.PLAIN);
//        // 绘制药品信息
//        List<PrescriptionInfoDTO.DrugInfo> drugInfos = prescriptionInfo.getDrugInfos();
//        if (CollectionUtil.isNotEmpty(drugInfos)) {
//            int index = 1;
//            for (PrescriptionInfoDTO.DrugInfo drugInfo : drugInfos) {
//                // 药品信息
//                layouts.add(new Layout(index + ". ", Align.RIGHT, 1));
//                layouts.add(new Layout(drugInfo.getCommonName(), Align.LEFT, 13));
//                layouts.add(new Layout(drugInfo.getSpec(), Align.LEFT, 5));
//                layouts.add(new Layout(drugInfo.getTotalTimes() + drugInfo.getUnit(), Align.LEFT, 5));
//                drawString(image, graphics, point, margin, false, layouts.toArray(new Layout[4]));
//                layouts.clear();
//
//                // 用法
//                layouts.add(new Layout(" ", Align.RIGHT, 1));
//                String usage = "用法：" + drugInfo.getUsage() + StrUtil.SPACE
//                        + "每次" + drugInfo.getSingleDose() + drugInfo.getSingleDoseUnit() + StrUtil.SPACE
//                        + drugInfo.getFrequency() + StrUtil.SPACE
//                        + "用药" + drugInfo.getDayNum() + "天";
//                layouts.add(new Layout(usage, Align.LEFT, 23));
//                drawString(image, graphics, point, margin, false, layouts.toArray(new Layout[2]));
//                layouts.clear();
//
//                // 绘制空行
//                drawBlankLine(point, 1, false);
//
//                index++;
//            }
//            // 绘制空行
//            drawBlankLine(point, 2, false);
//            // 处方药品结束
//            drawString(image, graphics, point, margin, false, new Layout("(以下空白)", Align.CENTER, COLUMNS));
//        }
//
//        // 重置坐标
//        point.setY(image.getHeight() - margin.getBottom());
//
//        // 绘制空行
//        drawBlankLine(point, 2, true);
//        // 底部签名信息
//        layouts.add(new Layout("合计金额：", Align.RIGHT, 3));
//        layouts.add(new Layout(prescriptionInfo.getTotalPrice() + "元", Align.LEFT, 5));
//        layouts.add(new Layout("医生签名：", Align.RIGHT, 3));
//        layouts.add(new Layout(doctorSignPicture, Align.LEFT, 5));
//        layouts.add(new Layout("药师签名：", Align.RIGHT, 3));
//        layouts.add(new Layout(pharmacistSignPicture, Align.LEFT, 5));
//        drawString(image, graphics, point, margin, true, layouts.toArray(new Layout[6]));
//        layouts.clear();
//
//        // 绘制空行
//        drawBlankLine(point, 2, true);
//        // 底部横线
//        drawHorizontalLine(image, graphics, point, margin, true);
//        // 设置画笔
//        setGraphics(graphics, Color.RED, FONT_SIZE_BODY, Font.PLAIN);
//        // 设置处方有效期
//        drawString(image, graphics, point, margin, false,
//                new Layout("该处方有效期3天", Align.CENTER, COLUMNS));
//
//        // 完成绘制
//        graphics.dispose();
//        return imageInputStream(image);
//    }

    private static InputStream imageInputStream(BufferedImage image) throws IOException {
        // 输出png图片
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(image, "jpg", baos); // 将BufferedImage写入到ByteArrayOutputStream中
        baos.flush();
        image.flush();
        return new ByteArrayInputStream(baos.toByteArray());
    }


    @Getter
    public static class Layout {
        /**
         * 内容
         */
        private String content;

        /**
         * 图片
         */
        private BufferedImage image;

        /**
         * 对齐方式
         */
        private Align align;

        /**
         * 占列数
         */
        private Integer col;

        public Layout(String content, Align align) {
            this.content = content;
            this.align = align;
        }

        public Layout(String content, Align align, Integer col) {
            this.content = content;
            this.align = align;
            this.col = col;
        }

        public Layout(BufferedImage image, Align align, Integer col) {
            this.image = image;
            this.align = align;
            this.col = col;
        }

        public Layout(String content, BufferedImage image, Align align, Integer col) {
            this.content = content;
            this.image = image;
            this.align = align;
            this.col = col;
        }
    }

    public enum Align {
        CENTER,
        LEFT,
        RIGHT,
        ;
    }
}