package com.sentum.drugsafe.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.itextpdf.text.*;
import com.itextpdf.text.Font;
import com.itextpdf.text.Image;
import com.itextpdf.text.pdf.BaseFont;
import com.lowagie.text.Cell;
import com.lowagie.text.HeaderFooter;
import com.lowagie.text.Table;
import com.lowagie.text.rtf.RtfWriter2;
import com.sentum.drugsafe.dto.FdaQueryCondition;
import com.sentum.drugsafe.enums.ConfigEnum;
import com.sentum.drugsafe.pojo.DrugContent;
import com.sentum.drugsafe.pojo.InstructionVo;
import com.sentum.drugsafe.service.DownloadService;
import com.sentum.drugsafe.utils.AnalyzeConditionUtils;
import com.sentum.drugsafe.utils.ConfigUtil;
import com.sentum.drugsafe.utils.WordToPdfUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.servlet.ServletOutputStream;
import javax.servlet.WriteListener;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpServletResponseWrapper;
import java.awt.*;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static java.awt.Color.GRAY;

@Slf4j
@Service
public class DownloadServiceImpl implements DownloadService {


    @Value("${evaluation.title.font.path}")
    private String TITLE_FONT_PATH;


    public static final Map<String, String> MY_CAREER_MAP =
            Collections.unmodifiableMap(new HashMap<String, String>() {{
                put("MD","医生" );
                put("PH","药师");
                put("LW","律师");
                put("CN","消费者");
                put("OT","其他健康专家");
                put("NO","未知");
            }});


    public static final Map<String, String> MY_CONSTANT_MAP =
            Collections.unmodifiableMap(new HashMap<String, String>() {{
                put("PS", "PS（首要怀疑药品，primary suspicion）");
                put("SS", "SS（次要怀疑药品，secondary suspicion）");
                put("C", "C（并用药品，concomitant）");
                put("I", "I（相互作用药品，interacting）");
            }});


    public static final Map<String, String> MY_OUTCOME_MAP =
            Collections.unmodifiableMap(new HashMap<String, String>() {{
                put("DE", "致死");
                put("LT", "威胁生命");
                put("DS", "致残");
                put("CA","导致先天异常" );
                put("HO","导致住院或住院时间延长");
                put("RI","需要干预以预防永久性损伤");
                put("OT","其他严重（重要医疗事件）");
            }});
    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    private ConfigUtil configUtil;

    //--------------------------------word样式设置----------------------------------------
    private com.lowagie.text.Paragraph createHeadWord(int fontSize, String title, int alignment) throws com.lowagie.text.DocumentException, IOException {
        com.lowagie.text.Font font = createFontWord(fontSize, Font.BOLD);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }



    private com.lowagie.text.Font createFontWord(int fontSize, int fontMode) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.pdf.BaseFont bfChinese = com.lowagie.text.pdf.BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED);
        return new com.lowagie.text.Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }

    public com.lowagie.text.Paragraph createDataWord(String title) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(12, Font.NORMAL);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    //无首行缩进
    public com.lowagie.text.Paragraph createDataWord2(String title) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(12, Font.NORMAL);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        paragraph.setIndentationLeft(0);
        return paragraph;
    }

    public com.lowagie.text.Paragraph createDataWord1(String title) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(12, Font.NORMAL);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(8);
        paragraph.setSpacingAfter(8);
        return paragraph;
    }

    private com.lowagie.text.Paragraph createHeadWordV1(int fontSize, String title, int alignment) throws com.lowagie.text.DocumentException, IOException {
        com.lowagie.text.Font font = createFontWordSongHui(fontSize, com.lowagie.text.Font.BOLD);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }
    private com.lowagie.text.Paragraph createHeadWordV2(int fontSize, String title, int alignment) throws com.lowagie.text.DocumentException, IOException {
        com.lowagie.text.Font font = createFontWordSong(fontSize, com.lowagie.text.Font.BOLD);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }


    private com.lowagie.text.Font createFontWordSong(int fontSize, int fontMode) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.pdf.BaseFont bfChinese = com.lowagie.text.pdf.BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, com.lowagie.text.pdf.BaseFont.EMBEDDED);
        return new com.lowagie.text.Font(bfChinese, fontSize, fontMode, GRAY);
    }

    private com.lowagie.text.Font createFontWordSongHui(int fontSize, int fontMode) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.pdf.BaseFont bfChinese = com.lowagie.text.pdf.BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, com.lowagie.text.pdf.BaseFont.EMBEDDED);
        return new com.lowagie.text.Font(bfChinese, fontSize, fontMode, Color.BLACK);}


    @SuppressWarnings("all")
    @Override
    public void download(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException {

        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=" + "药品安全性分析报告" + ".docx");
        ServletOutputStream outputStream = response.getOutputStream();
        //创建一个文档（默认大小A4，边距36, 36, 36, 36）
        com.lowagie.text.Document document = new com.lowagie.text.Document();
        //设置文档大小
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);
        //创建writer，通过writer将文档写入磁盘
        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        //打开文档，只有打开后才能往里面加东西
        document.open();
        ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
        if (classPathResource == null) {
            throw new IOException("Logo image not found in resources directory");
        }
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
        logo.scaleAbsolute(100, 30);
        logo.setAlignment(com.lowagie.text.Image.ALIGN_RIGHT); // 右对齐
        //           logo.setAbsolutePosition(30, 100); // 设置绝对位置，单位为像素
        // 创建页眉

        com.lowagie.text.Paragraph headerParagraph = new com.lowagie.text.Paragraph();
        if (!"juhe".equals(source)) {
            headerParagraph.add(logo);
        }
        headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

        // 创建 HeaderFooter 对象
        HeaderFooter header = new HeaderFooter(headerParagraph, false);
        header.setAlignment(HeaderFooter.ALIGN_RIGHT);
        header.setBorderWidth(0);

        // 设置页眉
        document.setHeader(header);
        JSONObject reportData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)),JSONObject.class,"drug_safe_report");
        JSONObject queryData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        //设置报告名称
        com.lowagie.text.Paragraph paragraphTitle = createHeadWord(26, reportData.getString("titleName"), com.lowagie.text.Element.ALIGN_CENTER);
        paragraphTitle.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        paragraphTitle.setSpacingBefore(180);
        paragraphTitle.setSpacingAfter(200);
        document.add(paragraphTitle);

        com.lowagie.text.Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", com.lowagie.text.Element.ALIGN_LEFT);
        headWord1.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        headWord1.setSpacingBefore(150);
        headWord1.setSpacingAfter(8);
        Calendar calendar = Calendar.getInstance();
        // 创建日期格式化对象
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
        // 格式化日期
        String formattedDate = sdf.format(calendar.getTime());

        com.lowagie.text.Paragraph headWord2 = createHeadWordV1(12, formattedDate, com.lowagie.text.Element.ALIGN_LEFT);
        headWord2.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        headWord2.setSpacingBefore(9);
        headWord2.setSpacingAfter(8);
        if (!"juhe".equals(source)) {
            document.add(headWord1);
            document.add(headWord2);
        }


        com.lowagie.text.Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容", com.lowagie.text.Element.ALIGN_CENTER);
        headWord3.setSpacingBefore(9);
        if (!"juhe".equals(source)) {
            document.add(headWord3);
        }






        //摘要 = 目的 + 方法 + 结果与结论
        document.newPage();
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph();

        //一、循证方法
        com.lowagie.text.Paragraph title1 = createHeadWord(14, "一、循证方法", Element.ALIGN_LEFT);
        document.add(title1);
        //1.1 检索策略
        com.lowagie.text.Paragraph title11 = createHeadWord(14, "1.1 检索策略", Element.ALIGN_LEFT);
        document.add(title11);


        try {

            JSONObject o = queryData.getJSONObject("fdaQuery");
            FdaQueryCondition fdaQueryCondition = JSONObject.parseObject(o.toString(), FdaQueryCondition.class);
            //年龄段
            List<String> age = fdaQueryCondition.getAge();
            //担任角色
            List<String> role = fdaQueryCondition.getRole();
            //适应症
            List<String> indication = fdaQueryCondition.getIndication();
            //结局
            List<String> seriousOutcome = fdaQueryCondition.getSeriousOutcome();
            //性别
            List<String> sex = fdaQueryCondition.getSex();
            //是否展示
            String isShowUnknown = fdaQueryCondition.getIsShowUnknown();
            //上报职业
            List<String> career = fdaQueryCondition.getCareer();
            //检索时间

            //季度
            com.lowagie.text.Paragraph paragraphDataDate = createDataWord("本研究数据来源于FAERS数据库，该数据库中的药品ADE信息由患者或卫生健康系统人员自主上报，每季度更新 1 次。目前数据库已更新至"+configUtil.getConfig(ConfigEnum.FEARS_END_JD)+"。");
            paragraphDataDate.setFirstLineIndent(25);
            document.add(paragraphDataDate);
            String dateStart = "2004-01-01";
            String dateEnd = configUtil.getConfig(ConfigEnum.FEARS_END_DATE);
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            if (ObjectUtils.isNotEmpty(queryData.getString("reportStartTime"))) {
                dateStart = simpleDateFormat.format(Long.parseLong(queryData.getString("reportStartTime")));
            }
            if (ObjectUtils.isNotEmpty(queryData.getString("reportEndTime"))){
                dateEnd = simpleDateFormat.format(Long.parseLong(queryData.getString("reportEndTime")));
            }
            //检索时间
            com.lowagie.text.Paragraph paragraphSearchDate = createDataWord("本研究提取了"+dateStart+"至"+dateEnd+"的ADE报告数据，进行回顾性药物警戒研究。由于数据每季度更新，患者上报信息可能发生变化，不可避免会和之前已公开的报告重复，故需要根据公布的删除文件进行去重处理。根据FDA的建议，当CASEID相同时选择最新的FDA_DT，当CASEID与FDA_DT都相同时选择更高的PRIMARYID，再删除重复病例。");
            paragraphSearchDate.setFirstLineIndent(25);
            document.add(paragraphSearchDate);

            //匹配信息
            StringBuilder stringBuilder = new StringBuilder();
            String string1 = reportData.getJSONObject("strategy").getString("drugName");
            stringBuilder.append("在“drug name”或“prod_ai”进行");
            stringBuilder.append("1".equals(queryData.getString("isVague"))?"模糊":"精准");
            stringBuilder.append("匹配，限定“");
            stringBuilder.append(string1);
            stringBuilder.append("”，“role_cod”为");
            for (String s : getRole(role)) {
                stringBuilder.append(s);
                stringBuilder.append("、");
            }
            stringBuilder.delete(stringBuilder.length() - 1, stringBuilder.length());
            stringBuilder.append("；从中筛选出相关ADE报告。");

            com.lowagie.text.Paragraph paragraphSearch = createDataWord(stringBuilder.toString());
            paragraphSearch.setFirstLineIndent(25);
            document.add(paragraphSearch);

            com.lowagie.text.Paragraph paragraphSearchOther = createDataWord("您选择的其他筛选条件为 ：");
            paragraphSearchOther.setFirstLineIndent(25);
            document.add(paragraphSearchOther);

            com.lowagie.text.Paragraph paragraphSearchOther1 = createDataWord1("未知数据："+("0".equals(isShowUnknown)?"不展示":"展示"));
            paragraphSearchOther1.setFirstLineIndent(25);
            document.add(paragraphSearchOther1);

            if (reportData.getIntValue("type") == 1 || reportData.getIntValue("type") == 3) {
                com.lowagie.text.Paragraph paragraphData2 = createDataWord1("不良反应: " + reportData.getJSONObject("strategy").getString("pt"));
                paragraphData2.setFirstLineIndent(25);
                document.add(paragraphData2);
            }
            if (!indication.contains("不限")){
                StringBuilder stringBuilder1 = new StringBuilder();
                stringBuilder1.append("适应症：");
                for (String s : indication) {
                    JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(s)), JSONObject.class, "pt_all_data");
                    String ptCh = "";
                    if (ptAllData != null) {
                        ptCh = ptAllData.getString("pt_ch");
                    } else if ("unknown".equals(s)) {
                        ptCh = "未知";
                    }
                    stringBuilder1.append(ptCh+"（"+s+"）");
                  stringBuilder1.append("、");
                }

                stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
                com.lowagie.text.Paragraph paragraphSearchOther2 = createDataWord1(stringBuilder1.toString());
                paragraphSearchOther2.setFirstLineIndent(20);
                document.add(paragraphSearchOther2);
            }

            if(!seriousOutcome.contains("不限")){
                StringBuilder stringBuilder1 = new StringBuilder();
                stringBuilder1.append("严重不良反应结局：");
                for (String s : seriousOutcome) {
                    stringBuilder1.append(MY_OUTCOME_MAP.get(s));
                    stringBuilder1.append("、");
                }
                stringBuilder1.delete(stringBuilder1.length() - 1,stringBuilder1.length());
                com.lowagie.text.Paragraph paragraphSearchOther2 = createDataWord1(stringBuilder1.toString());
                paragraphSearchOther2.setFirstLineIndent(25);
                document.add(paragraphSearchOther2);
            }
            if (!age.contains("不限")){
                StringBuilder stringBuilder1 = new StringBuilder();
                stringBuilder1.append("年龄：");
                for (String s : age) {
                    if ("成人".equals(s)){
                        stringBuilder1.append("成人（18-64岁）");
                    }else if("儿童".equals(s)){
                        stringBuilder1.append("儿童（≤18岁）");
                    }else if ("老年人".equals(s)){
                        stringBuilder1.append("老年人（≥65岁）");
                    }
                    stringBuilder1.append("、");
                }
                stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
                com.lowagie.text.Paragraph paragraphSearchOther2 = createDataWord1(stringBuilder1.toString());
                paragraphSearchOther2.setFirstLineIndent(25);
                document.add(paragraphSearchOther2);
            }

            if (!sex.contains("不限")){
                StringBuilder stringBuilder1 = new StringBuilder();
                stringBuilder1.append("性别：");
                for (String s : sex) {
                    stringBuilder1.append(s);
                    stringBuilder1.append("、");
                }
                stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
                com.lowagie.text.Paragraph paragraphSearchOther2 = createDataWord1(stringBuilder1.toString());
            }

            if (!career.contains("不限")){
                StringBuilder stringBuilder1 = new StringBuilder();
                stringBuilder1.append("职业：");
                for (String s : career) {
                    stringBuilder1.append(MY_CAREER_MAP.get(s));
                    stringBuilder1.append("、");
                }
                stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
                com.lowagie.text.Paragraph paragraphSearchOther2 = createDataWord1(stringBuilder1.toString());
                paragraphSearchOther2.setFirstLineIndent(25);
                document.add(paragraphSearchOther2);
            }

            com.lowagie.text.Paragraph searchMethodParagraph = createDataWord("方法学内容详见附录。");
            searchMethodParagraph.setFirstLineIndent(25);
            document.add(searchMethodParagraph);


            //二、循证结果
            com.lowagie.text.Paragraph title2 = createHeadWord(14, "二、循证结果", Element.ALIGN_LEFT);
            document.add(title2);
            com.lowagie.text.Paragraph evidenceBasedSummary = createDataWord(reportData.getJSONObject("result").getString("summary"));
            evidenceBasedSummary.setFirstLineIndent(25);
            document.add(evidenceBasedSummary);
            Boolean x;
            Pattern pattern = Pattern.compile("\\d+");
            Matcher matcher = pattern.matcher(reportData.getJSONObject("result").getString("summary"));
            String summaryCount = "0";
            while (matcher.find()) {
              summaryCount = matcher.group();
            }
            if (!"0".equals(summaryCount)) {
              x = false;

                    com.lowagie.text.Paragraph title21 = createHeadWord(14, "2.1 基本情况", Element.ALIGN_LEFT);
                    document.add(title21);
                    com.lowagie.text.Paragraph baseInfoSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("baseInfo").getString("summary"));
                    baseInfoSummay.setFirstLineIndent(25);
                    document.add(baseInfoSummay);

                    com.lowagie.text.Paragraph table1Title =
                            createHeadWord(14, reportData.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    table1Title.setSpacingAfter(10);
                    table1Title.setSpacingBefore(10);
                    document.add(table1Title);
                    Table table1 = new Table(3);
                    //信息/类别
                    {
                        Cell headCell1 = new Cell("信息/类别");
                        formatTableHead(headCell1);
                        headCell1.setRowspan(2);
                        table1.addCell(headCell1);
                        Cell headCell2 = new Cell("FAERS数据库");
                        formatTableHead(headCell2);
                        headCell2.setColspan(2);
                        table1.addCell(headCell2);
                        Cell headCell3 = new Cell("报告例数");
                        formatTableHead(headCell3);
                        table1.addCell(headCell3);
                        Cell headCell4 = new Cell("构成比");
                        formatTableHead(headCell4);
                        table1.addCell(headCell4);
                        for (JSONObject data : reportData.getJSONObject("result").getJSONObject("baseInfo")
                                .getJSONObject("table1").getJSONArray("data").toJavaList(JSONObject.class)) {
                            Cell dataCell1 = new Cell(data.getString("info"));
                            if (StrUtil.isNotBlank(data.getString("tag"))) {
                                dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                            }
                            table1.addCell(dataCell1);
                            Cell dataCell2 = new Cell(data.getString("case"));
                            formatTablData(dataCell2);
                            table1.addCell(dataCell2);
                            Cell dataCell3 = new Cell(data.getString("rate"));
                            formatTablData(dataCell3);
                            table1.addCell(dataCell3);
                        }
                    }
                    document.add(table1);


                com.lowagie.text.Paragraph table2Title =
                        createHeadWord(14, reportData.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table2").getString("title"), Element.ALIGN_CENTER);
                //table1Title.setFirstLineIndent(25);
                //设置段落前后间距
                table2Title.setSpacingAfter(10);
                table2Title.setSpacingBefore(10);
                document.add(table2Title);
                Table table2 = new Table(3);
                {
                    Cell headCell1 = new Cell("年份");
                    formatTableHead(headCell1);
                    table2.addCell(headCell1);
                    Cell headCell2 = new Cell("不良反应报告数量（份）");
                    formatTableHead(headCell2);
                    table2.addCell(headCell2);
                    Cell headCell3 = new Cell("占比");
                    formatTableHead(headCell3);
                    table2.addCell(headCell3);
                    for (JSONObject data : reportData.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table2").getJSONArray("data").toJavaList(JSONObject.class)) {
                        Cell dataCell1 = new Cell(data.getString("year"));
                        table2.addCell(dataCell1);
                        Cell dataCell2 = new Cell(data.getString("case"));
                        dataCell2.setHorizontalAlignment(Element.ALIGN_CENTER);
                        dataCell2.setVerticalAlignment(Element.ALIGN_MIDDLE);
                        table2.addCell(dataCell2);

                        Cell dataCell3 = new Cell(data.getString("rate"));
                        dataCell3.setHorizontalAlignment(Element.ALIGN_CENTER);
                        dataCell3.setVerticalAlignment(Element.ALIGN_MIDDLE);
                        table2.addCell(dataCell3);
                    }
                }
                document.add(table2);
                //只有单药显示此模块
                if (reportData.getIntValue("type") <= 1) {
                    //2.2 用药基本情况
                    //2.1 基本情况
                    //计数器
                    int count = 2;
                    if (CollUtil.isNotEmpty(reportData.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data"))) {

                        com.lowagie.text.Paragraph title22 = createHeadWord(14, "2." + count++ + " 用药情况分析", Element.ALIGN_LEFT);
                        document.add(title22);
                        com.lowagie.text.Paragraph baseDrugInfoSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("drugInfo").getString("summary"));
                        baseDrugInfoSummay.setFirstLineIndent(25);
                        document.add(baseDrugInfoSummay);
                        com.lowagie.text.Paragraph table3Title =
                                createHeadWord(14, reportData.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getString("title"), Element.ALIGN_CENTER);
                        //table1Title.setFirstLineIndent(25);
                        //设置段落前后间距
                        table3Title.setSpacingAfter(10);
                        table3Title.setSpacingBefore(10);
                        document.add(table3Title);
                        Table table3 = new Table(3);
                        {
                            Cell headCell1 = new Cell("影响因素");
                            formatTableHead(headCell1);
                            table3.addCell(headCell1);
                            Cell headCell2 = new Cell("报告例数");
                            formatTableHead(headCell2);
                            table3.addCell(headCell2);
                            Cell headCell3 = new Cell("占比");
                            formatTableHead(headCell3);
                            table3.addCell(headCell3);
                            for (JSONObject data : reportData.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").toJavaList(JSONObject.class)) {
                                Cell dataCell1 = new Cell(data.getString("info"));
                                if (StrUtil.isNotBlank(data.getString("tag"))) {
                                    dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                                }
                                table3.addCell(dataCell1);
                                Cell dataCell2 = new Cell(data.getString("case"));
                                formatTablData(dataCell2);
                                table3.addCell(dataCell2);
                                Cell dataCell3 = new Cell(data.getString("rate"));
                                formatTablData(dataCell3);
                                table3.addCell(dataCell3);
                            }
                        }
                        document.add(table3);

                    }
                    //2.3 用药适应症情况
                    if (CollUtil.isNotEmpty(reportData.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").getJSONArray("data"))) {

                        com.lowagie.text.Paragraph title23 = createHeadWord(14, "2." + count++ + "  用药适应征分析", Element.ALIGN_LEFT);
                        document.add(title23);
                        com.lowagie.text.Paragraph baseDrugIndicationSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("condition").getString("summary"));
                        baseDrugIndicationSummay.setFirstLineIndent(25);
                        document.add(baseDrugIndicationSummay);
                        com.lowagie.text.Paragraph table4Title =
                                createHeadWord(14, reportData.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").getString("title"), Element.ALIGN_CENTER);
                        //table1Title.setFirstLineIndent(25);
                        //设置段落前后间距
                        table4Title.setSpacingAfter(10);
                        table4Title.setSpacingBefore(10);
                        document.add(table4Title);
                        Table table4 = new Table(3);
                        {
                            Cell headCell1 = new Cell("用药适应症");
                            formatTableHead(headCell1);
                            table4.addCell(headCell1);
                            Cell headCell2 = new Cell("例数");
                            formatTableHead(headCell2);
                            table4.addCell(headCell2);
                            Cell headCell3 = new Cell("占比");
                            formatTableHead(headCell3);
                            table4.addCell(headCell3);
                            for (JSONObject data : reportData.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").getJSONArray("data").toJavaList(JSONObject.class)) {
                                Cell dataCell1 = new Cell(data.getString("indication"));
                                if (StrUtil.isNotBlank(data.getString("tag"))) {
                                    dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                                }
                                table4.addCell(dataCell1);
                                Cell dataCell2 = new Cell(data.getString("case"));
                                formatTablData(dataCell2);
                                table4.addCell(dataCell2);
                                Cell dataCell3 = new Cell(data.getString("rate"));
                                formatTablData(dataCell3);
                                table4.addCell(dataCell3);
                            }
                        }
                        document.add(table4);
                    }

                    if (CollUtil.isNotEmpty( reportData.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data"))) {


                        //2.4 给药方案及不良反应发生时间分布
                        com.lowagie.text.Paragraph title24 = createHeadWord(14, "2." + count++ + " 给药方案及不良反应发生时间分布", Element.ALIGN_LEFT);
                        document.add(title24);
                        com.lowagie.text.Paragraph baseDrugTimeSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getString("summary"));
                        baseDrugTimeSummay.setFirstLineIndent(25);
                        document.add(baseDrugTimeSummay);
                        com.lowagie.text.Paragraph table5Title =
                                createHeadWord(14, reportData.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getString("title"), Element.ALIGN_CENTER);
                        //table1Title.setFirstLineIndent(25);
                        //设置段落前后间距
                        table5Title.setSpacingAfter(10);
                        table5Title.setSpacingBefore(10);
                        document.add(table5Title);
                        Table table5 = new Table(3);
                        {
                            Cell headCell1 = new Cell("影响因素");
                            formatTableHead(headCell1);
                            table5.addCell(headCell1);
                            Cell headCell2 = new Cell("报告例数");
                            formatTableHead(headCell2);
                            table5.addCell(headCell2);
                            Cell headCell3 = new Cell("占比");
                            formatTableHead(headCell3);
                            table5.addCell(headCell3);
                            for (JSONObject data : reportData.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").toJavaList(JSONObject.class)) {
                                Cell dataCell1 = new Cell(data.getString("affect"));
                                if (StrUtil.isNotBlank(data.getString("tag"))) {
                                    dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                                }
                                table5.addCell(dataCell1);
                                Cell dataCell2 = new Cell(data.getString("case"));
                                formatTablData(dataCell2);
                                table5.addCell(dataCell2);
                                Cell dataCell3 = new Cell(data.getString("rate"));
                                formatTablData(dataCell3);
                                table5.addCell(dataCell3);
                            }
                        }
                        document.add(table5);

                        com.lowagie.text.Paragraph titleAdd = createHeadWord(12, "注释：不良反应发生时间：用药后首次出现不良反应的时间段", Element.ALIGN_LEFT);
                        document.add(titleAdd);

                    }

                    if (CollUtil.isNotEmpty(reportData.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getJSONArray("data"))){


                    //2.5 用药适应症情况
                    com.lowagie.text.Paragraph title25 = createHeadWord(14, "2."+count+++" 治疗与转归", Element.ALIGN_LEFT);
                    document.add(title25);
                    com.lowagie.text.Paragraph treatmentAndOutcomeSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("treatmentAndOutcome").getString("summary"));
                    treatmentAndOutcomeSummay.setFirstLineIndent(25);
                    document.add(treatmentAndOutcomeSummay);
                    com.lowagie.text.Paragraph table6Title =
                            createHeadWord(14, reportData.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    table6Title.setSpacingAfter(10);
                    table6Title.setSpacingBefore(10);
                    document.add(table6Title);
                    Table table6 = new Table(4);
                    {
                        Cell headCell1 = new Cell("治疗与转归");
                        formatTableHead(headCell1);
                        table6.addCell(headCell1);
                        Cell headCell2 = new Cell("结果");
                        formatTableHead(headCell2);
                        table6.addCell(headCell2);
                        Cell headCell3 = new Cell("例数");
                        formatTableHead(headCell3);
                        table6.addCell(headCell3);
                        Cell headCell4 = new Cell("占比");
                        formatTableHead(headCell4);
                        table6.addCell(headCell4);
                        Cell left1Cell = new Cell("重新使用药物反应是否再次出现");
                        left1Cell.setRowspan(4);
                        table6.addCell(left1Cell);
                        int i = 0;
                        for (JSONObject data : reportData.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getJSONArray("data").toJavaList(JSONObject.class)) {
                            if (i == 4) {
                                Cell left2Cell = new Cell("停药或减药后反应是否减轻或消失");
                                left2Cell.setRowspan(4);
                                table6.addCell(left2Cell);
                                Cell dataCell1 = new Cell(data.getString("result"));
                                table6.addCell(dataCell1);
                                Cell dataCell2 = new Cell(data.getString("case"));
                                formatTablData(dataCell2);
                                table6.addCell(dataCell2);
                                Cell dataCell3 = new Cell(data.getString("rate"));
                                formatTablData(dataCell3);
                                table6.addCell(dataCell3);
                            } else {
                                Cell dataCell1 = new Cell(data.getString("result"));
                                table6.addCell(dataCell1);
                                Cell dataCell2 = new Cell(data.getString("case"));
                                formatTablData(dataCell2);
                                table6.addCell(dataCell2);
                                Cell dataCell3 = new Cell(data.getString("rate"));
                                formatTablData(dataCell3);
                                table6.addCell(dataCell3);

                            }
                            i++;
                        }
                    }
                    document.add(table6);
                }

                }
                com.lowagie.text.Paragraph title3 = createHeadWord(14, "三、 不良反应及信号检测", Element.ALIGN_LEFT);
                document.add(title3);
                com.lowagie.text.Paragraph title31 = createHeadWord(14, "3.1  不良反应分析结果", Element.ALIGN_LEFT);
                document.add(title31);
                com.lowagie.text.Paragraph signalResultSummary = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getString("summary"));
                signalResultSummary.setFirstLineIndent(25);
                document.add(signalResultSummary);
                com.lowagie.text.Paragraph table7Title =
                        createHeadWord(14, reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").getString("title"), Element.ALIGN_CENTER);
                //table1Title.setFirstLineIndent(25);
                //设置段落前后间距
                table7Title.setSpacingAfter(10);
                table7Title.setSpacingBefore(10);
                document.add(table7Title);
                Table table7 = new Table(4);
                {
                    Cell headCell1 = new Cell("首选术语（PT）");
                    formatTableHead(headCell1);
                    table7.addCell(headCell1);
                    Cell headCell2 = new Cell("不良事件");
                    formatTableHead(headCell2);
                    table7.addCell(headCell2);
                    Cell headCell3 = new Cell("报告例数/例");
                    formatTableHead(headCell3);
                    table7.addCell(headCell3);
                    Cell headCell4 = new Cell("比例");
                    formatTableHead(headCell4);
                    table7.addCell(headCell4);
                    for (JSONObject data : reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").getJSONArray("data").toJavaList(JSONObject.class)) {
                        Cell dataCell1 = new Cell(data.getString("pt"));
                        table7.addCell(dataCell1);
                        Cell dataCell2 = new Cell(data.getString("badEvent"));
                        formatTablData(dataCell2);
                        table7.addCell(dataCell2);
                        Cell dataCell3 = new Cell(data.getString("case"));
                        formatTablData(dataCell3);
                        table7.addCell(dataCell3);
                        Cell dataCell4 = new Cell(data.getString("rate"));
                        formatTablData(dataCell4);
                        table7.addCell(dataCell4);
                    }
                }

                document.add(table7);

                com.lowagie.text.Paragraph title32 = createHeadWord(14, "3 .2  典型信号分析结果", Element.ALIGN_LEFT);
                document.add(title32);
                if (reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data").size() > 0) {
                    com.lowagie.text.Paragraph typicalSignalResultSummary = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getString("summary"));
                    typicalSignalResultSummary.setFirstLineIndent(25);
                    document.add(typicalSignalResultSummary);
                    com.lowagie.text.Paragraph table8Title =
                            createHeadWord(14, reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    table7Title.setSpacingAfter(10);
                    table7Title.setSpacingBefore(10);
                    document.add(table8Title);
                    Table table8 = new Table(6);
                    {
                        Cell headCell1 = new Cell("SOC分类/首选术语（PT）");
                        formatTableHead(headCell1);
                        table8.addCell(headCell1);
                        Cell headCell6 = new Cell("不良事件");
                        formatTableHead(headCell6);
                        table8.addCell(headCell6);
                        Cell headCell2 = new Cell("报告数/例");
                        formatTableHead(headCell2);
                        table8.addCell(headCell2);
                        Cell headCell3 = new Cell("ROR值（95%CI）");
                        formatTableHead(headCell3);
                        table8.addCell(headCell3);
                        Cell headCell4 = new Cell("EBGM值");
                        formatTableHead(headCell4);
                        table8.addCell(headCell4);
                        Cell headCell5 = new Cell("IC值（95%CI）");
                        formatTableHead(headCell5);
                        table8.addCell(headCell5);


                        for (JSONObject data : reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data").toJavaList(JSONObject.class)) {
                            Cell dataCell1 = new Cell(data.getString("soc"));
                            table8.addCell(dataCell1);
                            Cell dataCell2 = new Cell(data.getString("badEvent"));
                            formatTablData(dataCell2);
                            table8.addCell(dataCell2);
                            Cell dataCell3 = new Cell(data.getString("case"));
                            formatTablData(dataCell3);
                            table8.addCell(dataCell3);
                            Cell dataCell4 = new Cell(data.getString("ror"));
                            formatTablData(dataCell4);
                            table8.addCell(dataCell4);
                            Cell dataCell5 = new Cell(data.getString("ebgm"));
                            formatTablData(dataCell5);
                            table8.addCell(dataCell5);
                            Cell dataCell6 = new Cell(data.getString("ic"));
                            formatTablData(dataCell6);
                            table8.addCell(dataCell6);
                        }
                    }
                    document.add(table8);
                } else {
                    com.lowagie.text.Paragraph typicalSignal = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getString("typicalSignal"));
                    typicalSignal.setFirstLineIndent(25);
                    document.add(typicalSignal);
                }
            }else {
                 x = true;
            }
            String textTitle = x?"三、政策信息":"四、政策信息";
            String textTitle1 = x?"四、说明书安全性信息":"五、说明书安全性信息";
            String textTitle2 = x?"五、参考文献":"六、参考文献";
            String textTitle3 = x?"六、附录":"七、附录";
            com.lowagie.text.Paragraph title4 = createHeadWord(14, textTitle, Element.ALIGN_LEFT);
            document.add(title4);
            JSONArray policyInfo = reportData.getJSONArray("policyInfo");

            if (policyInfo.size()>0){
                for(JSONObject policy:policyInfo.toJavaList(JSONObject.class)){
                    com.lowagie.text.Paragraph policyPargraph = createDataWord(policy.getString("title").replaceAll("\\\\n",""));
                    policyPargraph.setFirstLineIndent(20);
                    document.add(policyPargraph);
                }
            }else {
                document.add(createDataWord("暂无内容"));
            }


//            com.lowagie.text.Paragraph title5 = createHeadWord(14, "五、临床试验安全性信息", Element.ALIGN_LEFT);
//            document.add(title5);
//            document.add(createDataWord("暂无内容"));

            com.lowagie.text.Paragraph title6 = createHeadWord(14, textTitle1, Element.ALIGN_LEFT);
            document.add(title6);
            {
                List<InstructionVo> instructions = reportData.getJSONArray("instruction").toJavaList(InstructionVo.class);
                if (instructions != null){

                    com.lowagie.text.Paragraph title51 = createHeadWord(14, (x?"4.1":"5.1")+" 黑框警告", Element.ALIGN_LEFT);
                    document.add(title51);
                    for (InstructionVo instruction : instructions) {

                        com.lowagie.text.Paragraph drugName = createDataWord(instruction.getDrugName());
                        drugName.setFirstLineIndent(20);
                        if (StrUtil.isNotEmpty(instruction.getDrugName())){
                            document.add(drugName);
                        }
                        List<DrugContent> warnings = instruction.getWarnings();
                        if (CollectionUtil.isNotEmpty(warnings)){
                            assembleListData(warnings,document,source);
                        }else {
                            com.lowagie.text.Paragraph policyPargraph = createDataWord("说明书中未提到黑框警告信息。");
                            policyPargraph.setFirstLineIndent(20);
                            document.add(policyPargraph);
                        }
                    }
                    com.lowagie.text.Paragraph title52 = createHeadWord(14, (x?"4.2":"5.2")+" 不良反应", Element.ALIGN_LEFT);
                    document.add(title52);
                    for (InstructionVo instruction : instructions) {
                        com.lowagie.text.Paragraph drugName = createDataWord(instruction.getDrugName());
                        drugName.setFirstLineIndent(20);
                        if (StrUtil.isNotEmpty(instruction.getDrugName())){
                            document.add(drugName);
                        }
                        if (CollectionUtil.isNotEmpty(instruction.getAdverseReactions())){
                            assembleListData(instruction.getAdverseReactions(),document,source);}
                        else {
                            com.lowagie.text.Paragraph policyPargraph = createDataWord("说明书中未提到不良反应信息。");
                            policyPargraph.setFirstLineIndent(20);
                            document.add(policyPargraph);
                        }
                    }

                    com.lowagie.text.Paragraph title53 = createHeadWord(14, (x?"4.3":"5.3")+" 禁忌症", Element.ALIGN_LEFT);
                    document.add(title53);
                    for (InstructionVo instruction : instructions) {
                        com.lowagie.text.Paragraph drugName = createDataWord(instruction.getDrugName());
                        drugName.setFirstLineIndent(20);
                        if (StrUtil.isNotEmpty(instruction.getDrugName())){
                            document.add(drugName);
                        }
                        if (CollectionUtil.isNotEmpty(instruction.getContraindications())){
                            assembleListData(instruction.getContraindications(),document,source);
                        }else {
                            com.lowagie.text.Paragraph policyPargraph = createDataWord("说明书中未提到禁忌症信息。");
                            policyPargraph.setFirstLineIndent(20);
                            document.add(policyPargraph);
                        }
                    }

                    com.lowagie.text.Paragraph title54 = createHeadWord(14, (x?"4.4":"5.4")+" 注意事项", Element.ALIGN_LEFT);
                    document.add(title54);
                    for (InstructionVo instruction : instructions) {
                        com.lowagie.text.Paragraph drugName = createDataWord(instruction.getDrugName());
                        drugName.setFirstLineIndent(20);
                        if (StrUtil.isNotEmpty(instruction.getDrugName())){
                            document.add(drugName);
                        }
                        if (CollectionUtil.isNotEmpty(instruction.getPrecautions())){
                            assembleListData(instruction.getPrecautions(),document,source);
                        }else {
                            com.lowagie.text.Paragraph policyPargraph = createDataWord("说明书中未提到注意事项信息。");
                            policyPargraph.setFirstLineIndent(20);
                            document.add(policyPargraph);
                        }
                    }

                }



            }

            {
                com.lowagie.text.Paragraph title7 = createHeadWord(14, textTitle2, Element.ALIGN_LEFT);
                document.add(title7);
                JSONArray reference = reportData.getJSONArray("references");
                for(String str:reference.toJavaList(String.class)){
                    com.lowagie.text.Paragraph instructionName = createDataWord(str);
                    document.add(instructionName);
                }
            }

            {
                //附录
                com.lowagie.text.Paragraph titleAppendix = createHeadWord(14, textTitle3, Element.ALIGN_LEFT);
                titleAppendix.setSpacingAfter(10);
                titleAppendix.setSpacingBefore(10);
                document.add(titleAppendix);
                //资料与方法
                com.lowagie.text.Paragraph titleAppendix1 = createHeadWord(14, "资料与方法", Element.ALIGN_LEFT);
                titleAppendix1.setSpacingAfter(10);
                titleAppendix1.setSpacingBefore(10);
                document.add(titleAppendix1);
                //数据来源
                com.lowagie.text.Paragraph titleAppendix2 = createHeadWord(14, "数据来源", Element.ALIGN_LEFT);
                titleAppendix2.setSpacingAfter(10);
                titleAppendix2.setSpacingBefore(10);
                document.add(titleAppendix2);
                //data
                com.lowagie.text.Paragraph data1 = createDataWord("本次研究数据来源于FAERS数据库中的公开数据。FAERS 包括了 FDA 收集的所有不良事件信息和用药错误信息( 包括欧洲报告可能与严重事件和其他非欧洲的数据有关)。其所有 ADEs 数据采用国际医学用语词典( Medical Dictionary for Drug Ｒegulatory Activities，MedDＲA)的首选术语( preferred terms，PTs) 进行编码。FAERS 数据库自 2004 年开始对外公开，每季度进行数据更新，数据信息量极大，可有效用于药品上市后安全性风险监测及评价，其可获得药物各个ADR的例数以及ADR的详情，包括年龄、性别、合并用药、转归等。");
                document.add(data1);
                //数据处理
                com.lowagie.text.Paragraph titleAppendix3 = createHeadWord(14, "数据处理", Element.ALIGN_LEFT);
                titleAppendix3.setSpacingAfter(10);
                titleAppendix3.setSpacingBefore(10);
                document.add(titleAppendix3);
                //data
//                com.lowagie.text.Paragraph data2 = createDataWord("由于FAERS数据库和VigiAccess数据库的数据结构差异，两个库的数据处理方式不同：FAERS数据库：本研究从该库中提取2004年第1季度至2023年第1季度，共77个季度中所有包含" + dr + "的ADE，剔除重复和错误数据后，筛选出以" +  reportData.getJSONObject("strategy").getString("drugName") + "为怀疑药物（首要怀疑和次要怀疑） " + (StringUtils.isNotEmpty(originalO) ? "并导致" + originalO : "") + " 的ADE报告进行分析。" + (type == 1 ? "" : "VigiAccess数据库：由于数据结构限制，本研究仅从该库中提取所有包含" + originalI + "的ADE报告进行分析，数据库限定时间为“建库时间”到2022-09-14。"));
//                data2.setFirstLineIndent(25);
//                document.add(data2);
                //信号检测方法
                com.lowagie.text.Paragraph titleAppendix4 = createHeadWord(14, "信号检测方法", Element.ALIGN_LEFT);
                titleAppendix4.setSpacingAfter(10);
                titleAppendix4.setSpacingBefore(10);
                document.add(titleAppendix4);
                //data
                com.lowagie.text.Paragraph data3 = createDataWord("本研究采用药物不良反应信号信息标准值( information component，IC) 、经验贝叶斯几何均值( empirical bayes geometric mean， EBGM ) 、报告比值比 ( reporting odds ratio，ROR) 进行信号检测。算法的具体计算公式及信号检测标准表 1，其中 a，b，c，d 的意义见表 2。");
                data3.setFirstLineIndent(25);
                document.add(data3);
                //（1）信息标准值
                com.lowagie.text.Paragraph titleAppendix5 = createHeadWord(14, "（1）信息标准值", Element.ALIGN_LEFT);
                titleAppendix5.setSpacingAfter(10);
                titleAppendix5.setSpacingBefore(10);
                document.add(titleAppendix5);
                //data
                com.lowagie.text.Paragraph data4 = createDataWord("IC 值是通过贝叶斯置信度递进神经网络 ( bayesian confidence propagation neural network， BCPNN) 获得的药物与不良反应之间的关联指标。由于药物不良反应监测数据库可以表达为由 a 种药物和 b 种不良反应构成的 a × b 矩阵。 基于目标不相称性测定分析理论，目标药物的不良反应事件在所有事件中出现的频率相对于背景事件明显不相称并达到一定的标准，则认为药物 A 和不良反应 B 是一个可疑的不良反应信号。因此，我们将 IC 值作为首个药物不良反应的识别指标。");
                data4.setFirstLineIndent(25);
                document.add(data4);
                //（2）经验贝叶斯几何均值
                com.lowagie.text.Paragraph titleAppendix6 = createHeadWord(14, "（2）经验贝叶斯几何均值", Element.ALIGN_LEFT);
                titleAppendix6.setSpacingAfter(10);
                titleAppendix6.setSpacingBefore(10);
                document.add(titleAppendix6);
                //data
                com.lowagie.text.Paragraph data5 = createDataWord("EBGM 是由伽玛泊松分布缩减法 ( gamma Poisson shrinker，GPS) 获得的药物与不良反应之间的关联指标，也是美国 FDA 使用的药物不良反应监测指标，基本假设是目标药物的不良反应报告数服从泊松分布。");
                data5.setFirstLineIndent(25);
                document.add(data5);
                //（3）报告比值比
                com.lowagie.text.Paragraph titleAppendix7 = createHeadWord(14, "（3）报告比值比", Element.ALIGN_LEFT);
                titleAppendix7.setSpacingAfter(10);
                titleAppendix7.setSpacingBefore(10);
                document.add(titleAppendix7);
                //data
                com.lowagie.text.Paragraph data61 = createDataWord("ROR 是通过频数法获得的药物与不良反应之间关系的关联指标，是暴露于某一药物的特定不良反应与其他不良反应的比值除以未暴露于该药物的特定不良反应与其他所有事件之比。");
                data61.setFirstLineIndent(25);
                document.add(data61);
                com.lowagie.text.Paragraph data62 = createDataWord("另外，本研究基于 BCPNN 检测方法绘制重点关注的药物-不良事件组合 IC 值及其 95%置信区间的时间扫描图谱。该图谱体现了数据库中目标不良事件随时间推移报告数增加时信号的变化趋势；若图谱呈平稳或上升趋势且置信区间逐渐变窄，则提示信号稳定且关联性强；若呈波动趋势则提示信号不稳定，关联性不强。");
                data62.setFirstLineIndent(25);
                document.add(data62);
                //插入图片
//                com.lowagie.text.Paragraph titleImage = createHeadWord(14, "计算公式和信号检测标准", Element.ALIGN_LEFT);
//                titleImage.setAlignment(Element.ALIGN_CENTER);
//                titleImage.setSpacingAfter(10);
//                titleImage.setSpacingBefore(10);
//                document.add(titleImage);
                ClassPathResource resource = new ClassPathResource("/static/data.png");
                InputStream inputImg = resource.getInputStream();
                byte[] bytex = IOUtils.toByteArray(inputImg);
                com.lowagie.text.Image image = com.lowagie.text.Image.getInstance(bytex);
                image.setAlignment(Image.ALIGN_CENTER);
                image.scaleAbsolute(500, 425);
                document.add(image);
                //创建 比值失衡测量法四格表
                com.lowagie.text.Paragraph titleTable = createHeadWord(14, "比值失衡测量法四格表", Element.ALIGN_LEFT);
                titleTable.setAlignment(Element.ALIGN_CENTER);
                titleTable.setSpacingAfter(10);
                titleTable.setSpacingBefore(10);
                document.add(titleTable);
                //data
                List<String> nameList = Arrays.asList("项目", "目标ADEs报告数", "其他ADEs报告数", "合计");
                Table table = new Table(4);
                //table.setWidth(com.lowagie.text.PageSize.A4.getWidth() - 100);
                com.lowagie.text.Font font = createFontWord(14, Font.NORMAL);
                for (String s : nameList) {
                    Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                    cell.setBackgroundColor(new Color(221, 221, 221));
                    cell.setUseAscender(true);
                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    table.addCell(cell);
                }
                //设置内容
                List<List<String>> dataList = new ArrayList<>();
                List<String> lastData1 = Arrays.asList("目标药物", "a", "b", "a+b");
                List<String> lastData2 = Arrays.asList("其他药物", "c", "d", "c+d");
                List<String> lastData3 = Arrays.asList("合计", "a+c", "b+d", "a+b+c+d");
                dataList.add(lastData1);
                dataList.add(lastData2);
                dataList.add(lastData3);
                for (List<String> list : dataList) {
                    for (String s : list) {
                        table.addCell(createTableContentWord(s));
                    }
                }
                document.add(table);
            }


            document.close();
            writer.close();
        }catch (Exception e){
            e.printStackTrace();
            document.close();
            writer.close();
            if (!"juhe".equals(source)) {
                log.error(e.getMessage(),e);
            }
        }
    }

    @SuppressWarnings("all")
    @Override
    public void downloadJd(String id, HttpServletResponse response, String source) throws DocumentException, IOException, com.lowagie.text.DocumentException {

        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=" + "药品安全性分析报告" + ".docx");
        ServletOutputStream outputStream = response.getOutputStream();
        //创建一个文档（默认大小A4，边距36, 36, 36, 36）
        com.lowagie.text.Document document = new com.lowagie.text.Document();
        //设置文档大小
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);
        //创建writer，通过writer将文档写入磁盘
        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        //打开文档，只有打开后才能往里面加东西
        document.open();
        ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
        if (classPathResource == null) {
            throw new IOException("Logo image not found in resources directory");
        }
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
        logo.scaleAbsolute(100, 30);
        logo.setAlignment(com.lowagie.text.Image.ALIGN_RIGHT); // 右对齐
        //           logo.setAbsolutePosition(30, 100); // 设置绝对位置，单位为像素
        // 创建页眉
        com.lowagie.text.Paragraph headerParagraph = new com.lowagie.text.Paragraph();
        if (!"juhe".equals(source)) {
            headerParagraph.add(logo);
        }
        headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

        // 创建 HeaderFooter 对象
        HeaderFooter header = new HeaderFooter(headerParagraph, false);
        header.setAlignment(HeaderFooter.ALIGN_RIGHT);
        header.setBorderWidth(0);

        // 设置页眉
        document.setHeader(header);
        JSONObject reportData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)),JSONObject.class,"drug_safe_report_jd");
        if (reportData == null) {
            throw new RuntimeException("未找到对应的报告数据，id: " + id);
        }
        JSONObject queryData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        String drugName = reportData.getJSONObject("strategy").getString("drugName");

        //设置报告名称
        com.lowagie.text.Paragraph paragraphTitle = createHeadWord(26, "基于JADER数据库的"+drugName+"不良反应事件信号挖掘与分析", com.lowagie.text.Element.ALIGN_CENTER);
        paragraphTitle.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        paragraphTitle.setSpacingBefore(180);
        paragraphTitle.setSpacingAfter(200);
        document.add(paragraphTitle);

        com.lowagie.text.Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", com.lowagie.text.Element.ALIGN_LEFT);
        headWord1.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        headWord1.setSpacingBefore(150);
        headWord1.setSpacingAfter(8);
        Calendar calendar = Calendar.getInstance();
        // 创建日期格式化对象
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
        // 格式化日期
        String formattedDate = sdf.format(calendar.getTime());

        com.lowagie.text.Paragraph headWord2 = createHeadWordV1(12, formattedDate, com.lowagie.text.Element.ALIGN_LEFT);
        headWord2.setAlignment(com.lowagie.text.Element.ALIGN_CENTER);
        headWord2.setSpacingBefore(9);
        headWord2.setSpacingAfter(8);
        if (!"juhe".equals(source)) {
            document.add(headWord1);
            document.add(headWord2);
        }


        com.lowagie.text.Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容", com.lowagie.text.Element.ALIGN_CENTER);
        headWord3.setSpacingBefore(9);
        if (!"juhe".equals(source)) {
            document.add(headWord3);
        }






        //摘要 = 目的 + 方法 + 结果与结论
        document.newPage();
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph();

        //一、循证方法
        com.lowagie.text.Paragraph title1 = createHeadWord(14, "1、资料与方法", Element.ALIGN_LEFT);
        document.add(title1);
        //1.1 检索策略
        com.lowagie.text.Paragraph title11 = createHeadWord(14, "1.1 数据来源", Element.ALIGN_LEFT);
        document.add(title11);

        com.lowagie.text.Paragraph dataWord1 = createDataWord("数据来源于 JADER数据库（https://www.pmda.go.jp）。JADER数据库以csv文件的形式储存，下载 JADER 数据库中有建库至"+configUtil.getConfig(ConfigEnum.FEARS_END_DATE_JD2)+"上报所有的 ADE 报告数据。");
        document.add(dataWord1);
        com.lowagie.text.Paragraph dataWord2 = createDataWord("包括 4个表格，其中人口统计信息（DEMO）表记录了患者的基本情况、报告人等信息；药物信息（DRUG）表记录了药品名称、给药途径、给药剂量等信息；ADE信息（REAC）表记录了ADE和转归结局；原发疾病（HIST）表记录了患者的原发疾病等信息。所有表格的数据结构均含有报告识别号，通过该字段对各表格进行关联。");
        document.add(dataWord2);


        com.lowagie.text.Paragraph title12 = createHeadWord(14, "1.2 数据提取", Element.ALIGN_LEFT);
        document.add(title12);
        com.lowagie.text.Paragraph dataWord3 = createDataWord("以"+drugName+"作为关键词在JADER数据库中进行检索，分析药物参与度为“可疑”的报告。");
        document.add(dataWord3);
        com.lowagie.text.Paragraph dataWord4 = createDataWord("JADER 数据库采用《国际医学用语词典》（MedDRA）中的首选术语（PT）编码不良事件。根据 MedDRA 对各不良事件进行中日文映射，并整理对应的主系统器官分类（SOC）。");
        document.add(dataWord4);

        com.lowagie.text.Paragraph title13 = createHeadWord(14, "1.3 数据挖掘", Element.ALIGN_LEFT);
        document.add(title13);
        com.lowagie.text.Paragraph dataWord5 = createDataWord("对筛选出的目标不良事件报告进行描述性统计分析。为保证结果的可靠性，减少单一算法引起的偏倚，本研究采用药物不良反应信号信息标准值( information component，IC) 、经验贝叶斯几何均值( empirical bayes geometric mean， EBGM ) 、报告比值比 ( reporting odds ratio，ROR) 进行信号检测。3 种算法均是基于AEs的报告遵循两两列联表的假设（表1），计算公式和检测阈值如表2 所示。当计算结果满足阈值条件时，则提示生成 1 个阳性信号，即目标药物和目标不良事件之间存在统计学关联，且信号值越高，其关联性越强。");
        document.add(dataWord5);
        ClassPathResource resource = new ClassPathResource("/static/img_2.png");
        InputStream inputImg = resource.getInputStream();
        byte[] bytex = IOUtils.toByteArray(inputImg);
        com.lowagie.text.Image image = com.lowagie.text.Image.getInstance(bytex);
        image.setAlignment(Image.ALIGN_CENTER);
        image.scaleAbsolute(500, 125);
        document.add(image);

        ClassPathResource resource1 = new ClassPathResource("/static/ing_1.png");
        InputStream inputImg1 = resource1.getInputStream();
        byte[] bytex1 = IOUtils.toByteArray(inputImg1);
        com.lowagie.text.Image image1 = com.lowagie.text.Image.getInstance(bytex1);
        image1.setAlignment(Image.ALIGN_CENTER);
        image1.scaleAbsolute(500, 425);
        document.add(image1);


        try {


            //二、循证结果
            com.lowagie.text.Paragraph title2 = createHeadWord(14, "2、结果", Element.ALIGN_LEFT);
            document.add(title2);
            com.lowagie.text.Paragraph evidenceBasedSummary = createDataWord(reportData.getJSONObject("result").getString("summary"));
            evidenceBasedSummary.setFirstLineIndent(25);
            document.add(evidenceBasedSummary);
            Boolean x;
            Pattern pattern = Pattern.compile("\\d+");
            Matcher matcher = pattern.matcher(reportData.getJSONObject("result").getString("summary"));
            String summaryCount = "0";
            while (matcher.find()) {
                summaryCount = matcher.group();
            }
            if (!"0".equals(summaryCount)) {
                x = false;
                //2.1 基本情况
                com.lowagie.text.Paragraph title21 = createHeadWord(14, "2.1 基本情况", Element.ALIGN_LEFT);
                document.add(title21);
                com.lowagie.text.Paragraph baseInfoSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("baseInfo").getString("summary"));
                baseInfoSummay.setFirstLineIndent(25);
                document.add(baseInfoSummay);

                com.lowagie.text.Paragraph table1Title =
                        createHeadWord(14, reportData.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getString("title"), Element.ALIGN_CENTER);
                //table1Title.setFirstLineIndent(25);
                //设置段落前后间距
                table1Title.setSpacingAfter(10);
                table1Title.setSpacingBefore(10);
                document.add(table1Title);
                Table table1 = new Table(3);
                //信息/类别
                {
                    Cell headCell1 = new Cell("信息/类别");
                    formatTableHead(headCell1);
                    headCell1.setRowspan(2);
                    table1.addCell(headCell1);
                    Cell headCell2 = new Cell("JADER数据库");
                    formatTableHead(headCell2);
                    headCell2.setColspan(2);
                    table1.addCell(headCell2);
                    Cell headCell3 = new Cell("报告例数");
                    formatTableHead(headCell3);
                    table1.addCell(headCell3);
                    Cell headCell4 = new Cell("构成比");
                    formatTableHead(headCell4);
                    table1.addCell(headCell4);
                    for (JSONObject data : reportData.getJSONObject("result").getJSONObject("baseInfo")
                            .getJSONObject("table1").getJSONArray("data").toJavaList(JSONObject.class)) {
                        Cell dataCell1 = new Cell(data.getString("info"));
                        if (StrUtil.isNotBlank(data.getString("tag"))) {
                            dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                        }
                        table1.addCell(dataCell1);
                        Cell dataCell2 = new Cell(data.getString("case"));
                        formatTablData(dataCell2);
                        table1.addCell(dataCell2);
                        Cell dataCell3 = new Cell(data.getString("rate"));
                        formatTablData(dataCell3);
                        table1.addCell(dataCell3);
                    }
                }
                document.add(table1);


                //只有单药显示此模块
                if (reportData.getIntValue("type") <= 1) {
                    //2.2 用药基本情况
                    com.lowagie.text.Paragraph title22 = createHeadWord(14, "2.2给药情况和处置转归", Element.ALIGN_LEFT);
                    document.add(title22);
                    com.lowagie.text.Paragraph baseDrugInfoSummay = createDataWord(reportData.getJSONObject("result").getJSONObject("drugInfo").getString("summary"));
                    baseDrugInfoSummay.setFirstLineIndent(25);
                    document.add(baseDrugInfoSummay);
                    com.lowagie.text.Paragraph table3Title =
                            createHeadWord(14, reportData.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    table3Title.setSpacingAfter(10);
                    table3Title.setSpacingBefore(10);
                    document.add(table3Title);
                    Table table3 = new Table(3);
                    {
                        Cell headCell1 = new Cell("类别");
                        formatTableHead(headCell1);
                        table3.addCell(headCell1);
                        Cell headCell2 = new Cell("例数");
                        formatTableHead(headCell2);
                        table3.addCell(headCell2);
                        Cell headCell3 = new Cell("占比");
                        formatTableHead(headCell3);
                        table3.addCell(headCell3);
                        for (JSONObject data : reportData.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").toJavaList(JSONObject.class)) {
                            Cell dataCell1 = new Cell(data.getString("info"));
                            if (StrUtil.isNotBlank(data.getString("tag"))) {
                                dataCell1 = new Cell(createHeadWord(12, data.getString("tag"), Element.ALIGN_LEFT));
                            }
                            table3.addCell(dataCell1);
                            Cell dataCell2 = new Cell(data.getString("case"));
                            formatTablData(dataCell2);
                            table3.addCell(dataCell2);
                            Cell dataCell3 = new Cell(data.getString("rate"));
                            formatTablData(dataCell3);
                            table3.addCell(dataCell3);
                        }
                    }
                    document.add(table3);


                    //2.3 用药适应症情况
                    com.lowagie.text.Paragraph title23 = createHeadWord(14, "2.3 ADE频率分析", Element.ALIGN_LEFT);
                    document.add(title23);
                    com.lowagie.text.Paragraph baseDrugIndicationSummay = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getString("summary"));
                    baseDrugInfoSummay.setFirstLineIndent(25);
                    document.add(baseDrugIndicationSummay);
                    com.lowagie.text.Paragraph table4Title =
                            createHeadWord(14, reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    table4Title.setSpacingAfter(10);
                    table4Title.setSpacingBefore(10);
                    document.add(table4Title);
                    Table table4 = new Table(5);
                    {
                        Cell headCell1 = new Cell("序号");
                        formatTableHead(headCell1);
                        table4.addCell(headCell1);
                        Cell headCell2 = new Cell("日文TP");
                        formatTableHead(headCell2);
                        table4.addCell(headCell2);
                        Cell headCell3 = new Cell("中文TP");
                        formatTableHead(headCell3);
                        table4.addCell(headCell3);
                        Cell headCell4 = new Cell("频次");
                        formatTableHead(headCell4);
                        table4.addCell(headCell4);
                        Cell headCell5 = new Cell("占比");
                        formatTableHead(headCell5);
                        table4.addCell(headCell5);

                        for (JSONObject data : reportData.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").getJSONArray("data").toJavaList(JSONObject.class)) {
                            Cell dataCell1 = new Cell(data.getString("rank"));
                            table4.addCell(dataCell1);
                            Cell dataCell2 = new Cell(data.getString("pt"));
                            formatTablData(dataCell2);
                            table4.addCell(dataCell2);
                            Cell dataCell3 = new Cell(data.getString("badEvent"));
                            formatTablData(dataCell3);
                            table4.addCell(dataCell3);
                            Cell dataCell4 = new Cell(data.getString("case"));
                            formatTablData(dataCell4);
                            table4.addCell(dataCell4);
                            Cell dataCell5 = new Cell(data.getString("rate"));
                            formatTablData(dataCell5);
                            table4.addCell(dataCell5);
                        }
                    }
                    document.add(table4);


                    //2.5 用药适应症情况

                }


                com.lowagie.text.Paragraph title31 = createHeadWord(14, "2.4 ADE信号分析", Element.ALIGN_LEFT);
                document.add(title31);


                if (reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").getJSONArray("data").size() > 0) {
                    com.lowagie.text.Paragraph typicalSignalResultSummary = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getString("summary"));
                    typicalSignalResultSummary.setFirstLineIndent(25);
                    document.add(typicalSignalResultSummary);
                    com.lowagie.text.Paragraph table8Title =
                            createHeadWord(14, reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").getString("title"), Element.ALIGN_CENTER);
                    //table1Title.setFirstLineIndent(25);
                    //设置段落前后间距
                    document.add(table8Title);
                    Table table8 = new Table(8);
                    float[] widths = {1, 2, 2, 1, 1, 2, 1, 2}; // 每列的相对宽度比例
                    table8.setWidths(widths);
                    {
                        Cell headCell1 = new Cell("序号");
                        formatTableHead(headCell1);
                        table8.addCell(headCell1);
                        Cell headCell6 = new Cell("日文Pt");
                        formatTableHead(headCell6);
                        table8.addCell(headCell6);
                        Cell headCell2 = new Cell("中文PT");
                        formatTableHead(headCell2);
                        table8.addCell(headCell2);
                        Cell headCell3 = new Cell("频次");
                        formatTableHead(headCell3);
                        table8.addCell(headCell3);
                        Cell headCell4 = new Cell("占比");
                        formatTableHead(headCell4);
                        table8.addCell(headCell4);
                        Cell headCell5 = new Cell("ROR值（95%CI）");
                        formatTableHead(headCell5);
                        table8.addCell(headCell5);
                        Cell headCell8 = new Cell("EBGM值");
                        formatTableHead(headCell8);
                        table8.addCell(headCell8);
                        Cell headCell7 = new Cell("IC值（95%CI）");
                        formatTableHead(headCell7);
                        table8.addCell(headCell7);




                        for (JSONObject data : reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").getJSONArray("data").toJavaList(JSONObject.class)) {

                            Cell dataCell1 = new Cell(data.getString("rank"));
                            table8.addCell(dataCell1);
                            Cell dataCell2 = new Cell(data.getString("pt"));
                            formatTablData(dataCell2);
                            table8.addCell(dataCell2);
                            Cell dataCell3 = new Cell(data.getString("badEvent"));
                            formatTablData(dataCell3);
                            table8.addCell(dataCell3);
                            Cell dataCell4 = new Cell(data.getString("case"));
                            formatTablData(dataCell4);
                            table8.addCell(dataCell4);
                            Cell dataCell5 = new Cell(data.getString("rate"));
                            formatTablData(dataCell5);
                            table8.addCell(dataCell5);
                            Cell dataCell6 = new Cell(data.getString("ror"));
                            formatTablData(dataCell6);
                            table8.addCell(dataCell6);
                            Cell dataCell7 = new Cell(data.getString("ebgm"));
                            formatTablData(dataCell7);
                            table8.addCell(dataCell7);
                            Cell dataCell8 = new Cell(data.getString("ic"));
                            formatTablData(dataCell8);
                            table8.addCell(dataCell8);
                        }
                    }
                    document.add(table8);
                } else {
                    com.lowagie.text.Paragraph typicalSignal = createDataWord(reportData.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").getString("summary"));
                    typicalSignal.setFirstLineIndent(25);
                    document.add(typicalSignal);
                }
            }else {
                x = true;
            }
            com.lowagie.text.Paragraph title31 = createHeadWord(14, "3、本研究的局限性", Element.ALIGN_LEFT);
            document.add(title31);
            com.lowagie.text.Paragraph title32 = createDataWord("JADER 数据库是自发的报告系统，可能存在错报、漏报和重复报告等，无法计算ADE的发生率。此外，ROR法的分析结果只能评估药品与 ADE 之间的关联强度不能确定因果关系，需要进行前瞻性研究和评估予以确定。尽管使用 JADER 数据库进行药物安全性监测研究有一定局限性，但其仍然可为我国的临床用药提供安全性参考。");
            document.add(title32);


            document.close();
            writer.close();
        }catch (Exception e){
            e.printStackTrace();
            document.close();
            writer.close();
            if (!"juhe".equals(source)) {
                log.error(e.getMessage(),e);
            }
        }
    }



    //解析key-value格式

    public void assembleListData(List<DrugContent> data, com.lowagie.text.Document document, String source) {
        ArrayList<Map<String, Object>> maps = new ArrayList<>();
        for (DrugContent datum : data) {
            HashMap<String, Object> stringObjectHashMap = new HashMap<>();
            stringObjectHashMap.put("tag", datum.getTag());
            stringObjectHashMap.put("content", datum.getContent());
            maps.add(stringObjectHashMap);
        }
        if (CollUtil.isNotEmpty(maps)) {
            for (Map<String, Object> map : maps) {
                String result;
                String tag = map.get("tag").toString();
                if ("text".equals(tag)) {
                    if (Objects.isNull(map.get("content"))){
                        continue;
                    }
                    result = map.get("content").toString();

                     result = result.replaceAll("<br>", "");
                     result = result.replaceAll("</br>", "");
                    try {
                        com.lowagie.text.Paragraph policyPargraph = createDataWord(result);
                        policyPargraph.setFirstLineIndent(10);
                        document.add(policyPargraph);
                    } catch (Exception e) {
                        if (!"juhe".equals(source)) {
                            log.error(e.getMessage(), e);
                        }
                    }
                }
                if ("img".equals(tag)) {
                    if (Objects.isNull(map.get("content"))) {
                        continue;
                    }
                    String base64String = map.get("content").toString();
                    try {
                        // 移除Base64数据前缀 "data:image/jpeg;base64," 或其他格式的前缀，如果你的字符串包含这些的话
                        base64String = base64String.replaceAll("^(data:image/.*;base64,)", "");
                        // Base64解码
                        byte[] imageBytes = Base64.getDecoder().decode(base64String);
                        com.lowagie.text.Image image = com.lowagie.text.Image.getInstance(imageBytes);
                        //添加图片
                        image.setAlignment(Element.ALIGN_CENTER);
                        image.setBackgroundColor(Color.white);
                        image.scaleToFit(500, 500);
                        //                        image.setXYRatio(0.1f);
                        document.add(image);
                    } catch (Exception e) {
                        System.err.println("转换图片时发生错误: " + e.getMessage());
                    }
                }
            }
        }
    }




    private List<String> getRole(List<String> role) {
        ArrayList<String> roles = new ArrayList<>();
        if (role.size()<4){
            for (String s : role) {
               roles.add(MY_CONSTANT_MAP.get(s));
            }
            return roles;
        }
        roles.add("全部");
           return roles;
    }

    private void formatTableHead(Cell cell){
        cell.setBackgroundColor(new Color(221, 221, 221));
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
    }
    private void formatTablData(Cell cell){
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
    }

    private Cell createTableContentWord(String text) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(14, Font.NORMAL);
        Cell cell = new Cell(new com.lowagie.text.Phrase(text, font));
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        return cell;
    }



    // 新添加的生成 PDF 的方法
    public void guideDownloadPdf(String id, HttpServletResponse response, String source) throws IOException, com.lowagie.text.DocumentException {
        // 创建一个虚拟的 HttpServletResponse 用于缓存生成的 Word 文件
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        HttpServletResponse mockResponse = new HttpServletResponseWrapper(response) {
            @Override
            public ServletOutputStream getOutputStream() throws IOException {
                return new ServletOutputStream() {
                    @Override
                    public boolean isReady() {
                        return true;
                    }

                    @Override
                    public void setWriteListener(WriteListener listener) {
                        // 不需要实现
                    }

                    @Override
                    public void write(int b) throws IOException {
                        baos.write(b);
                    }
                };
            }

            @Override
            public PrintWriter getWriter() throws IOException {
                return new PrintWriter(new OutputStreamWriter(baos));
            }
        };

        // 调用原方法生成 Word 文件
        try {
            download(id, mockResponse, source);
        } catch (DocumentException e) {
            throw new RuntimeException(e);
        }

        // 生成唯一的临时文件名
        String uuid = UUID.randomUUID().toString();
        File tempWordFile = File.createTempFile("guide_report_" + uuid, ".doc");
        try (FileOutputStream fos = new FileOutputStream(tempWordFile)) {
            baos.writeTo(fos);
        }

        // 生成唯一的 PDF 临时文件名
        File tempPdfFile = File.createTempFile("guide_report_" + uuid, ".pdf");
        WordToPdfUtil.convertWordToPdf(tempWordFile.getAbsolutePath(), tempPdfFile.getAbsolutePath());
        // 提供 PDF 文件下载
        response.setContentType("application/pdf");
        String fileName = "";

        response.setHeader("Content-Disposition", "attachment;fileName= 药品安全性分析报告.pdf");
        ServletOutputStream pdfOutputStream = response.getOutputStream();
        try (FileInputStream pdfInputStream = new FileInputStream(tempPdfFile)) {
            IOUtils.copy(pdfInputStream, pdfOutputStream);
        }

        // 删除临时文件
        tempWordFile.delete();
        tempPdfFile.delete();

        if (!"juhe".equals(source)) {
            log.info("----------指南报告 PDF 下载完成----------");
        }
    }




    public void guideDownloadJdPdf(String id, HttpServletResponse response, String source) throws IOException, com.lowagie.text.DocumentException {
        // 创建一个虚拟的 HttpServletResponse 用于缓存生成的 Word 文件
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        HttpServletResponse mockResponse = new HttpServletResponseWrapper(response) {
            @Override
            public ServletOutputStream getOutputStream() throws IOException {
                return new ServletOutputStream() {
                    @Override
                    public boolean isReady() {
                        return true;
                    }

                    @Override
                    public void setWriteListener(WriteListener listener) {
                        // 不需要实现
                    }

                    @Override
                    public void write(int b) throws IOException {
                        baos.write(b);
                    }
                };
            }

            @Override
            public PrintWriter getWriter() throws IOException {
                return new PrintWriter(new OutputStreamWriter(baos));
            }
        };

        // 调用原方法生成 Word 文件
        try {
            downloadJd(id, mockResponse, source);
        } catch (DocumentException e) {
            throw new RuntimeException(e);
        }

        // 生成唯一的临时文件名
        String uuid = UUID.randomUUID().toString();
        File tempWordFile = File.createTempFile("guide_report_" + uuid, ".doc");
        try (FileOutputStream fos = new FileOutputStream(tempWordFile)) {
            baos.writeTo(fos);
        }

        // 生成唯一的 PDF 临时文件名
        File tempPdfFile = File.createTempFile("guide_report_" + uuid, ".pdf");
        WordToPdfUtil.convertWordToPdf(tempWordFile.getAbsolutePath(), tempPdfFile.getAbsolutePath());
        // 提供 PDF 文件下载
        response.setContentType("application/pdf");
        String fileName = "";

        response.setHeader("Content-Disposition", "attachment;fileName= 药品安全性分析报告.pdf");
        ServletOutputStream pdfOutputStream = response.getOutputStream();
        try (FileInputStream pdfInputStream = new FileInputStream(tempPdfFile)) {
            IOUtils.copy(pdfInputStream, pdfOutputStream);
        }

        // 删除临时文件
        tempWordFile.delete();
        tempPdfFile.delete();

        if (!"juhe".equals(source)) {
            log.info("----------指南报告 PDF 下载完成----------");
        }
    }




}

