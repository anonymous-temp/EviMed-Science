package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.lowagie.text.*;
import com.lowagie.text.Font;
import com.lowagie.text.Image;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.rtf.RtfWriter2;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.io.IOException;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

import static java.awt.Color.GRAY;
import static org.apache.kafka.common.requests.DeleteAclsResponse.log;

@Service
public class Download {
    @Autowired
    private MongoTemplate mongoTemplate;

    private final String TITLE_FONT_PATH = "/data/evimed_v4/simsun.TTF";
    //    private final String TITLE_FONT_PATH = "static/simsun.TTF";

    /**
     * 标题样式
     */
    private Paragraph createHeadWord(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWord(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private Paragraph createHeadSecondWord(String title) throws DocumentException, IOException {
        Font font = createFontWord(12, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        paragraph.setFirstLineIndent(25);
        return paragraph;
    }

    /**
     * 内容样式
     */
    public Paragraph createDataWord(String title) throws IOException, DocumentException {
        title = title.replaceAll("\\n$", "");
        Font font = createFontWord(12, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(5);
        paragraph.setSpacingAfter(5);
        return paragraph;
    }


    public Paragraph createDataWordV1(String title) throws IOException, DocumentException {
        title = title.replaceAll("\\n$", "");
        Font font = createFontWord(27, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(5);
        paragraph.setSpacingAfter(5);
        return paragraph;
    }

    private Font createFontWord(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }

    private Paragraph createHeadWordV1(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWordSongHui(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private Paragraph createHeadWordV2(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFontWordSong(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }



    private Font createFontWordSong(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, GRAY);
    }

    private Font createFontWordSongHui(int fontSize, int fontMode) throws IOException, DocumentException {
        BaseFont bfChinese = BaseFont.createFont(TITLE_FONT_PATH, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }


    private Cell createTableContentWord(String text) throws IOException, DocumentException {
        Font font = createFontWord(13, Font.NORMAL);
        Cell cell = new Cell(new Phrase(text, font));
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        return cell;
    }


    public void guideDownloadWord(String id, HttpServletResponse response) throws IOException, DocumentException {
        JSONObject drugAnalyzeData = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData != null) {
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            Font font = createFontWord(13, Font.NORMAL);
            String fileName = drugAnalyzeData.getString("title");
            String drugName = drugAnalyzeData.getString("drugName");
            String drugInfo = drugAnalyzeData.getString("drugInfo");
            String diseaseName = drugAnalyzeData.getString("disease");
            //总得分
            String totalScore = drugAnalyzeData.getJSONObject("overallSummary").getString("comprehensiveScore");
            //推荐情况
            String status = drugAnalyzeData.getJSONObject("overallSummary").getString("status");
            String recommendation = drugAnalyzeData.getJSONObject("overallSummary").getString("recommendation");
            //药学特性
            String pharmaceuticalCharacteristicsScore = "0";
            //有效性
            String effectivenessScore = "0";
            //安全性
            String safetyScore = "0";
            //经济性
            String economicalScore = "0";
            //其他属性
            String otherAttributesScore = "0";
            JSONArray dimensionDiagram = drugAnalyzeData.getJSONObject("overallSummary").getJSONArray("dimensionDiagram");
            for (int i = 0; i < dimensionDiagram.size(); i++) {
                JSONObject jsonObject = dimensionDiagram.getJSONObject(i);
                String name = jsonObject.getString("name");
                switch (name) {
                    case "安全性":
                        safetyScore = jsonObject.getString("value");
                        break;
                    case "有效性":
                        effectivenessScore = jsonObject.getString("value");
                        break;
                    case "经济性":
                        economicalScore = jsonObject.getString("value");
                        break;
                    case "其他属性":
                        otherAttributesScore = jsonObject.getString("value");
                        break;
                    case "药学特性":
                        pharmaceuticalCharacteristicsScore = jsonObject.getString("value");
                        break;
                }
            }
            //是否属于国家基本药物
            boolean essentialMedicines = false;
            //否被纳入了国家医保目录
            boolean reimbursementList = false;
            String reimbursement = "";
            String paymentLimits = "";
            //是否列为国家集中采购药品
            boolean procurementOfDrugs = false;
            //国家基本药物得分
            String essentialMedicinesScore = "0";
            //国家医保目录得分
            String reimbursementListScore = "0";
            //国家集中采购药品得分
            String procurementOfDrugsScore = "0";
            JSONObject otherAttributes = drugAnalyzeData.getJSONObject("otherAttributes");
            if (otherAttributes != null) {
                //判定药品归属
                essentialMedicines = otherAttributes.getBoolean("essentialMedicines");
                paymentLimits = otherAttributes.getString("paymentLimits");
                reimbursementList = otherAttributes.getBoolean("reimbursementList");
                if (reimbursementList) {
                    reimbursement = otherAttributes.getString("reimbursement");
                }
                procurementOfDrugs = otherAttributes.getBoolean("procurementOfDrugs");
                //判定得分
                String essentialMedicinesScore1 = otherAttributes.getString("essentialMedicinesScore");
                if (essentialMedicinesScore1 != null) {
                    essentialMedicinesScore = essentialMedicinesScore1;
                }
                String reimbursementListScore1 = otherAttributes.getString("reimbursementListScore");
                if (reimbursementListScore1 != null) {
                    reimbursementListScore = reimbursementListScore1;
                }
                String procurementOfDrugsScore1 = otherAttributes.getString("procurementOfDrugsScore");
                if (procurementOfDrugsScore1 != null) {
                    procurementOfDrugsScore = procurementOfDrugsScore1;
                }
            }
            log.info("----------开始进行指南报告下载----------");
            response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
            ServletOutputStream outputStream = response.getOutputStream();
            //创建一个文档（默认大小A4，边距36, 36, 36, 36）
            Document document = new Document();
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
            logo.setAlignment(Image.ALIGN_RIGHT); // 右对齐
            //           logo.setAbsolutePosition(30, 100); // 设置绝对位置，单位为像素
            // 创建页眉
            Paragraph headerParagraph = new Paragraph();
            headerParagraph.add(logo);
            headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

            // 创建 HeaderFooter 对象
            HeaderFooter header = new HeaderFooter(headerParagraph, false);
            header.setAlignment(HeaderFooter.ALIGN_RIGHT);
            header.setBorderWidth(0);

            // 设置页眉
            document.setHeader(header);

            //设置报告名称
            Paragraph paragraphTitle = createDataWordV1(fileName);
            paragraphTitle.setAlignment(Element.ALIGN_CENTER);
            paragraphTitle.setSpacingBefore(190);
            paragraphTitle.setSpacingAfter(190);
            document.add(paragraphTitle);

            Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", Element.ALIGN_LEFT);
            headWord1.setAlignment(Element.ALIGN_CENTER);
            headWord1.setSpacingBefore(120);
            headWord1.setSpacingAfter(8);
            document.add(headWord1);
            Calendar calendar = Calendar.getInstance();
            // 创建日期格式化对象
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            // 格式化日期
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);


            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);

            HashMap<String, String> guideMaxMap = new HashMap<>();

            //摘要 = 目的 + 方法 + 结果与结论
            document.newPage();
            Paragraph paragraph = new Paragraph();
            Chunk chunkAbstract = new Chunk("摘要：", createFontWord(12, Font.BOLD));
            paragraph.add(chunkAbstract);
            //目的
            Chunk chunkObjective = new Chunk("目的 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkObjective);
            paragraph.add(new Chunk("依据《中国医疗机构药品评价与遴选快速指南（第二版）》（简称《指南》） 对" + drugName + "治疗" + diseaseName + "进行药品临床综合评价。", createFontWord(13, Font.NORMAL)));
            //方法
            Chunk chunkMethod = new Chunk("方法 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkMethod);
            paragraph.add(new Chunk("该指南通过对药品药学特性（28分），有效性（27分），安全性（25分），经济性（10分）和其他属性（10分） 5 个方面内容，对" + drugName + "治疗" + diseaseName + "临床综合评价进行归纳总结。", createFontWord(13, Font.NORMAL)));
            //结果与结论
            Chunk chunkConclusion = new Chunk("结果与结论 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkConclusion);
            recommendation = recommendation.replace("临床上", "");
//            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，"+status+"临床上使用" + drugName + "用于治疗" + diseaseName + "。", createFontWord(13, Font.NORMAL)));
            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，" + recommendation, createFontWord(13, Font.NORMAL)));
            paragraph.setSpacingBefore(10);
            paragraph.setSpacingAfter(10);
            document.add(paragraph);
            //一、评价目的
            document.add(createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT));
            Paragraph evaluationPurposeData = createDataWord("本研究通过药学特性、安全性、有效性、经济性以及其他属性5个维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。");
            evaluationPurposeData.setFirstLineIndent(25);
            document.add(evaluationPurposeData);
            //二、评价药品
            document.add(createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT));
            Paragraph evaluationDrugData = createDataWord(drugInfo);
            evaluationDrugData.setFirstLineIndent(25);
            document.add(evaluationDrugData);
            //三、评价过程
            document.add(createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT));
            Paragraph evaluationProcessData = createDataWord("本研究的研究方法主要是对" + drugName + "治疗" + diseaseName + "进行药品临床综合价值评估，根据《中国医疗机构药品评价与遴选快速指南（第二版）》进行量化打分，其评估维度包括药学特性、安全性、有效性、经济性以及其他属性。总分加和为100分。");
            evaluationProcessData.setFirstLineIndent(25);
            document.add(evaluationProcessData);
            //四、评价结果
            document.add(createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT));
            Paragraph evaluationInfoData = createDataWord(drugName + "治疗" + diseaseName + "综合评价结果最终得分共计" + totalScore + "分，其中药学特性最终得分" + pharmaceuticalCharacteristicsScore + "分，有效性最终得分" + effectivenessScore + "分，安全性最终得分" + safetyScore + "分，经济性最终得分" + economicalScore + "分，其他属性最终得分" + otherAttributesScore + "分。具体评分结果如下：");
            evaluationInfoData.setFirstLineIndent(25);
            document.add(evaluationInfoData);
            //1、药学特性（共28分，得分：24分）
            document.add(createHeadWord(14, "1、药学特性（共" + guideMaxMap.get("药学特性") + "分，得分：" + pharmaceuticalCharacteristicsScore + "分）", Element.ALIGN_LEFT));
            Map<String, String> pharmaceuticalDataMap = new HashMap<>();
            Map<String, String> pharmaceuticalScoreMap = new HashMap<>();
            String pharmaceuticalJson = drugAnalyzeData.getJSONObject("pharmaceuticalCharacteristics").getJSONArray("table").toJSONString();
            pharmaceuticalJson = pharmaceuticalJson.replaceAll("<br/>", "\n");
            JSONArray pharmaceuticalArr = JSONArray.parseArray(pharmaceuticalJson);
            if (pharmaceuticalArr.size() > 1) {
                for (int i = 1; i < pharmaceuticalArr.size(); i++) {
                    JSONArray jsonArray = pharmaceuticalArr.getJSONArray(i);
                    pharmaceuticalDataMap.put(jsonArray.getString(1), jsonArray.getString(2));
                    pharmaceuticalScoreMap.put(jsonArray.getString(1), jsonArray.getString(3));
                }
            }
            //1.1 药理作用
            document.add(createHeadSecondWord("1.1 药理作用（" + pharmaceuticalScoreMap.get("药理作用") + "）"));
            Paragraph data11 = createDataWord(pharmaceuticalDataMap.get("药理作用"));
            data11.setFirstLineIndent(25);
            document.add(data11);
            //1.2 体内过程
            document.add(createHeadSecondWord("1.2 体内过程（" + pharmaceuticalScoreMap.get("体内过程") + "）"));
            Paragraph data12 = createDataWord(pharmaceuticalDataMap.get("体内过程"));
            data12.setFirstLineIndent(25);
            document.add(data12);
            //1.3 药剂学与使用方法
            document.add(createHeadSecondWord("1.3 药剂学与使用方法（" + pharmaceuticalScoreMap.get("药剂学与使用方法") + "）"));
            String txt12 = pharmaceuticalDataMap.get("药剂学与使用方法");
            if (StringUtils.isNotBlank(txt12)) {
                Paragraph data13 = createDataWord(txt12.replaceAll("</br>", "\n"));
                data13.setFirstLineIndent(25);
                document.add(data13);
            }
            //1.4 贮藏条件
            document.add(createHeadSecondWord("1.4 贮藏条件（" + pharmaceuticalScoreMap.get("贮藏条件") + "）"));
            Paragraph data14 = createDataWord(pharmaceuticalDataMap.get("贮藏条件"));
            data14.setFirstLineIndent(25);
            document.add(data14);
            //1.5 药品有效期
            document.add(createHeadSecondWord("1.5 药品有效期（" + pharmaceuticalScoreMap.get("有效期") + "）"));
            Paragraph data15 = createDataWord(pharmaceuticalDataMap.get("有效期"));
            data15.setFirstLineIndent(25);
            document.add(data15);
            //2、有效性（共27分，得分：21分）
            document.add(createHeadWord(14, "2、有效性（共" + guideMaxMap.get("有效性") + "分，得分：" + effectivenessScore + "分）", Element.ALIGN_LEFT));
            JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
            if (effectiveness != null) {
                //适应症得分
                String indicationScore = effectiveness.getString("indicationScore") != null ? effectiveness.getString("indicationScore") : "0";
                //证据推荐详情得分推荐得分
                String guideAndLiteratureScore = effectiveness.getString("guideAndLiteratureScore") != null ? effectiveness.getString("guideAndLiteratureScore") : "0";
                //临床疗效得分
                String effectiveScore = effectiveness.getString("effectivenessScore") != null ? effectiveness.getString("effectivenessScore") : "0";
                //2.1 适应症
                document.add(createHeadSecondWord("2.1 适应症（" + indicationScore + "）"));
                if (StringUtils.isNotBlank(effectiveness.getString("indication"))) {
                    Paragraph effectivenessDataParagraph1 = createDataWord(effectiveness.getString("indication"));
                    effectivenessDataParagraph1.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph1);
                } else {
                    Paragraph effectivenessDataParagraph1 = createDataWord("暂无数据");
                    effectivenessDataParagraph1.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph1);
                }
                int guideLiteratureScore = Integer.parseInt(guideAndLiteratureScore);
                document.add(createHeadSecondWord("2.2 证据推荐情况（" + guideLiteratureScore + "）"));

                int x = 1;
                if (CollUtil.isNotEmpty(effectiveness.getJSONArray("guidePc"))) {
                    JSONArray guidePc = effectiveness.getJSONArray("guidePc");
                    for (JSONObject jsonObject : guidePc.toJavaList(JSONObject.class)) {
                        String showField = jsonObject.getString("showField");
                        String content = jsonObject.getString("content");
                        Paragraph fontWord = createDataWord("（" + x + "）" + showField);
                        Paragraph contentWord = createDataWord(content);
                        fontWord.setFirstLineIndent(25);
                        document.add(fontWord);
                        contentWord.setFirstLineIndent(30);
                        document.add(contentWord);
                        x++;

                    }

                } else {
                    //2.2 指南推荐
                    JSONArray guide = effectiveness.getJSONArray("guide");
                    String effectivenessData22 = new JSONArray().toJSONString();
                    if (CollUtil.isNotEmpty(guide)) {
                        effectivenessData22 = effectiveness.getJSONArray("guide").toJSONString();
                    }
//                    Table effectivenessTable = new Table(4);
                    int x1 = 1;
                    JSONArray effectivenessArr = JSONArray.parseArray(effectivenessData22);
                    if (effectivenessArr.size() > 1) {
                        for (int i = 0; i < effectivenessArr.size(); i++) {
                            if (i == 0){
                                continue;
                            }else {
                                JSONArray jsonArray = effectivenessArr.getJSONArray(i);
                                String guideContent = jsonArray.getString(1)+"发表的《"+
                                        jsonArray.getString(0)+"》，"+jsonArray.getString(4);
                                Paragraph fontWord = createDataWord("（" + x1 + "）" + guideContent);
                                x1++;
                                fontWord.setFirstLineIndent(25);
                                document.add(fontWord);

                            }

                        }
//                    document.add(createHeadSecondWord("2.2.1 指南推荐 "));
//                        for (int i = 0; i < effectivenessArr.size(); i++) {
//                            JSONArray jsonArray = effectivenessArr.getJSONArray(i);
//                            if (i == 0) {
//                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                    if (i1==3){
//                                        continue;
//                                    }
//                                    String s = jsonArray.getString(i1);
//                                    Cell cell = new Cell(new Phrase(s, font));
//                                    cell.setBackgroundColor(new Color(221, 221, 221));
//                                    cell.setUseAscender(true);
//                                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
//                                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
//                                    effectivenessTable.addCell(cell);
//                                }
//                            } else {
//                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                    String s = jsonArray.getString(i1);
//                                    if (i1 == 3) {
//                                       continue;
//                                    } else {
//                                        effectivenessTable.addCell(createTableContentWord(s));
//                                    }
//                                }
//                            }
//                        }
//                        document.add(effectivenessTable);
                    } else {
                        //2.2 文献推荐
                        String literature = effectiveness.getJSONArray("literature").toJSONString();
//                        Table literatureTable = new Table(4);
                        JSONArray literatureArr = JSONArray.parseArray(literature);
                        if (literatureArr.size() > 1) {
//                        document.add(createHeadSecondWord("2.2.1 文献推荐"));
                            for (int i = 0; i < literatureArr.size(); i++) {
                                JSONArray jsonArray = literatureArr.getJSONArray(i);

                                String literatureContent = jsonArray.getString(1)+"发表的《"+
                                        jsonArray.getString(0)+"》，"+jsonArray.getString(4);
                                Paragraph fontWord = createDataWord("（" + x1 + "）" + literatureContent);
                                x1++;
                                fontWord.setFirstLineIndent(25);
                                document.add(fontWord);




                            }
//                                JSONArray jsonArray = literatureArr.getJSONArray(i);
//                                if (i == 0) {
//                                    for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                        String s = jsonArray.getString(i1);
//                                        Cell cell = new Cell(new Phrase(s, font));
//                                        cell.setBackgroundColor(new Color(221, 221, 221));
//                                        cell.setUseAscender(true);
//                                        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
//                                        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
//                                        literatureTable.addCell(cell);
//                                    }
//                                } else {
//                                    for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                        String s = jsonArray.getString(i1);
//                                        if (i1 == 4) {
//                                            Cell cell = new Cell(new Phrase(s, font));
//                                            cell.setUseAscender(true);
//                                            literatureTable.addCell(cell);
//                                        } else {
//                                            literatureTable.addCell(createTableContentWord(s));
//                                        }
//                                    }
//                                }
//                            }
//                            document.add(literatureTable);
                        } else {
                            Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南或系统评价/Meta分析等证据推荐。");
                            effectivenessDataParagraph.setFirstLineIndent(25);
                            document.add(effectivenessDataParagraph);
                        }
//                    Paragraph effectivenessDataParagraph = createDataWord("暂时无法找到该药物治疗此疾病的相关指南推荐");
//                    effectivenessDataParagraph.setFirstLineIndent(25);
//                    document.add(effectivenessDataParagraph);
                    }
                }
//                //2.2 文献推荐
//                document.add(createHeadSecondWord("2.2.2 文献推荐"));
//                String literature = effectiveness.getJSONArray("literature").toJSONString();
//                Table literatureTable = new Table(4);
//                JSONArray literatureArr = JSONArray.parseArray(literature);
//                if (literatureArr.size() > 1) {
//                    for (int i = 0; i < literatureArr.size(); i++) {
//                        JSONArray jsonArray = literatureArr.getJSONArray(i);
//                        if (i == 0) {
//                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                String s = jsonArray.getString(i1);
//                                Cell cell = new Cell(new Phrase(s, font));
//                                cell.setBackgroundColor(new Color(221, 221, 221));
//                                cell.setUseAscender(true);
//                                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
//                                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
//                                literatureTable.addCell(cell);
//                            }
//                        } else {
//                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                String s = jsonArray.getString(i1);
//                                if (i1 == 4) {
//                                    Cell cell = new Cell(new Phrase(s, font));
//                                    cell.setUseAscender(true);
//                                    literatureTable.addCell(cell);
//                                } else {
//                                    literatureTable.addCell(createTableContentWord(s));
//                                }
//                            }
//                        }
//                    }
//                    document.add(literatureTable);
//                } else {
//                    Paragraph effectivenessDataParagraph = createDataWord("暂时无法找到该药物治疗此疾病的相关文献(系统评价/Meta分析)推荐");
//                    effectivenessDataParagraph.setFirstLineIndent(25);
//                    document.add(effectivenessDataParagraph);
//                }
                //2.3 临床疗效
                document.add(createHeadSecondWord("2.3 临床疗效（" + effectiveScore + "）"));
                if (StringUtils.isNotBlank(effectiveness.getString("effectiveness"))) {
                    Paragraph effectivenessDataParagraph3 = createDataWord(effectiveness.getString("effectiveness"));
                    effectivenessDataParagraph3.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph3);
                } else {
                    Paragraph effectivenessDataParagraph3 = createDataWord("暂无数据");
                    effectivenessDataParagraph3.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph3);
                }
            }
            //3、安全性（共25分，得分：17.5分）
            document.add(createHeadWord(14, "3、安全性（共" + guideMaxMap.get("安全性") + "分，得分：" + safetyScore + "分）", Element.ALIGN_LEFT));
            Map<String, String> safetyDataMap = new HashMap<>();
            Map<String, String> safetyScoreMap = new HashMap<>();
            String safetyJson = drugAnalyzeData.getJSONObject("safety").getJSONArray("table").toJSONString();
            String specialPopulationsScore = drugAnalyzeData.getJSONObject("safety").getString("specialPopulationsScore");
            String safetyOtherScore = drugAnalyzeData.getJSONObject("safety").getString("safetyOtherScore");
            safetyJson = safetyJson.replaceAll("<br/>", "\n");
            JSONArray safetyArr = JSONArray.parseArray(safetyJson);
            if (safetyArr.size() > 1) {
                for (int i = 1; i < safetyArr.size(); i++) {
                    JSONArray jsonArray = safetyArr.getJSONArray(i);
                    safetyDataMap.put(jsonArray.getString(1), jsonArray.getString(2));
                    safetyScoreMap.put(jsonArray.getString(1), jsonArray.getString(3));
                }
            }
            //3.1 中度不良反应
            document.add(createHeadSecondWord("3.1 中度不良反应（" + safetyScoreMap.get("中度不良反应") + "）"));
            Paragraph data31 = createDataWord(safetyDataMap.get("中度不良反应"));
            data31.setFirstLineIndent(25);
            document.add(data31);
            //3.2 重度不良反应
            document.add(createHeadSecondWord("3.2 重度不良反应（" + safetyScoreMap.get("重度不良反应") + "）"));
            Paragraph data32 = createDataWord(safetyDataMap.get("重度不良反应"));
            data32.setFirstLineIndent(25);
            document.add(data32);
            //3.3 特殊人群
            document.add(createHeadSecondWord("3.3 特殊人群（" + specialPopulationsScore + "）"));
            document.add(createHeadSecondWord("3.3.1 孕妇及哺乳期妇女（" + safetyScoreMap.get("孕妇及哺乳期妇女") + "）"));
            String text331 = safetyDataMap.get("孕妇及哺乳期妇女");
            if (StringUtils.isNotBlank(text331)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text331 = text331.replaceAll("</br>", "\n");
            }
            Paragraph data331 = createDataWord(text331);
            data331.setFirstLineIndent(25);
            document.add(data331);
            document.add(createHeadSecondWord("3.3.2 儿童（" + safetyScoreMap.get("儿童") + "）"));
            String text332 = safetyDataMap.get("儿童");
            if (StringUtils.isNotBlank(text332)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text332 = text332.replaceAll("</br>", "\n");
            }
            Paragraph data332 = createDataWord(text332);
            data332.setFirstLineIndent(25);
            document.add(data332);
            document.add(createHeadSecondWord("3.3.3 老人（" + safetyScoreMap.get("老人") + "）"));
            String text333 = safetyDataMap.get("老人");
            if (StringUtils.isNotBlank(text333)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text333 = text333.replaceAll("</br>", "\n");
            }
            Paragraph data333 = createDataWord(text333);
            data333.setFirstLineIndent(25);
            document.add(data333);
            document.add(createHeadSecondWord("3.3.4 肝肾功能异常者（" + safetyScoreMap.get("肝肾功能异常者") + "）"));
            String text334 = safetyDataMap.get("肝肾功能异常者");
            if (StringUtils.isNotBlank(text334)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text334 = text334.replaceAll("</br>", "");
            }
            Paragraph data334 = createDataWord(text334);
            data334.setFirstLineIndent(25);
            document.add(data334);
            //3.4 相互作用
            document.add(createHeadSecondWord("3.4 相互作用（" + safetyScoreMap.get("相互作用") + "）"));
            Paragraph data34 = createDataWord(safetyDataMap.get("相互作用"));
            data34.setFirstLineIndent(25);
            document.add(data34);
            //3.5 其他
            document.add(createHeadSecondWord("3.5 其他（" + safetyOtherScore + "）"));
//            if (StringUtils.isNotBlank(safetyDataMap.get("其他不良反应"))) {
//                Paragraph data35 = createDataWord(safetyDataMap.get("其他不良反应"));
//                data35.setFirstLineIndent(25);
//                document.add(data35);
//            }
            document.add(createHeadSecondWord("3.5.1 不良反应可逆性（" + safetyScoreMap.get("不良反应可逆性") + "）"));
            String text351 = safetyDataMap.get("不良反应可逆性");
            Paragraph dataWord351 = createDataWord(text351);
            dataWord351.setFirstLineIndent(25);
            document.add(dataWord351);
            document.add(createHeadSecondWord("3.5.2 致畸性、致癌性（" + safetyScoreMap.get("致畸性、致癌性") + "）"));
            String text352 = safetyDataMap.get("致畸性、致癌性");
            Paragraph dataWord352 = createDataWord(text352);
            dataWord352.setFirstLineIndent(25);
            document.add(dataWord352);
            document.add(createHeadSecondWord("3.5.3 用药警示（" + safetyScoreMap.get("用药警示") + "）"));
            String text353 = safetyDataMap.get("用药警示");
            Paragraph dataWord353 = createDataWord(text353);
            dataWord353.setFirstLineIndent(25);
            document.add(dataWord353);

            //4、经济性（共10分，得分：1.21分）
            document.add(createHeadWord(14, "4、经济性（共" + guideMaxMap.get("经济性") + "分，得分：" + economicalScore + "分）", Element.ALIGN_LEFT));
            JSONObject economical = drugAnalyzeData.getJSONObject("economical");
            if (economical != null) {
                //（1）同通用名药物：
                document.add(createHeadSecondWord("（1）同通用名药物："));
                String sameGericName = economical.getString("sameGericName");
                if (StringUtils.isNotBlank(sameGericName)) {
                    Paragraph economicalDataParagraph1 = createDataWord(sameGericName);
                    economicalDataParagraph1.setFirstLineIndent(25);
                    document.add(economicalDataParagraph1);
                } else {
                    Paragraph effectivenessDataParagraph3 = createDataWord("暂无数据");
                    effectivenessDataParagraph3.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph3);
                }
                //（2）主要适应证可替代药品：
                document.add(createHeadSecondWord("（2）主要适应证可替代药品："));
                String indicationReplace = economical.getString("indicationReplace");
                if (StringUtils.isNotBlank(indicationReplace)) {
                    Paragraph economicalDataParagraph2 = createDataWord(indicationReplace);
                    economicalDataParagraph2.setFirstLineIndent(25);
                    document.add(economicalDataParagraph2);
                } else {
                    Paragraph effectivenessDataParagraph3 = createDataWord("暂无数据");
                    effectivenessDataParagraph3.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph3);
                }
            }
            /*if (economical != null) {
                //4.1 同通用名药品
                String genericDrugsScore = economical.getString("genericDrugsScore") != null ? economical.getString("genericDrugsScore") : "";
                document.add(createHeadSecondWord(13, "4.1 同通用名药品（" + genericDrugsScore + "）", Element.ALIGN_LEFT));
                JSONObject genericDrugs = economical.getJSONObject("genericDrugs");
                if (genericDrugs != null) {
                    Paragraph data41 = createDataWord(genericDrugs.getString("title"));
                    data41.setFirstLineIndent(25);
                    document.add(data41);
                    String economicalData41 = genericDrugs.getJSONArray("table").toJSONString();
                    Table economicalTable41 = new Table(6);
                    JSONArray economicalArr1 = JSONArray.parseArray(economicalData41);
                    if (economicalArr1.size() > 1) {
                        for (int i = 0; i < economicalArr1.size(); i++) {
                            JSONArray jsonArray = economicalArr1.getJSONArray(i);
                            if (i == 0) {
                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                    String s = jsonArray.getString(i1);
                                    Cell cell = new Cell(new Phrase(s, font));
                                    cell.setBackgroundColor(new Color(221, 221, 221));
                                    cell.setUseAscender(true);
                                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                                    economicalTable41.addCell(cell);
                                }
                            } else {
                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                    String s = jsonArray.getString(i1);
                                    economicalTable41.addCell(createTableContentWord(s));
                                }
                            }
                        }
                        document.add(economicalTable41);
                    } else {
                        Paragraph economicalDataParagraph = createDataWord("暂无数据");
                        economicalDataParagraph.setFirstLineIndent(25);
                        document.add(economicalDataParagraph);
                    }
                }
                //4.2 主要适应证可替代药品
                String alternativeMedicinesScore = economical.getString("alternativeMedicinesScore") != null ? economical.getString("alternativeMedicinesScore") : "";
                document.add(createHeadSecondWord(13, "4.2 主要适应证可替代药品（" + alternativeMedicinesScore + "）", Element.ALIGN_LEFT));
                JSONObject alternativeMedicines = economical.getJSONObject("alternativeMedicines");
                if (alternativeMedicines != null) {
                    Paragraph data42 = createDataWord(alternativeMedicines.getString("title"));
                    data42.setFirstLineIndent(25);
                    document.add(data42);
                    String economicalData42 = alternativeMedicines.getJSONArray("table").toJSONString();
                    Table economicalTable42 = new Table(6);
                    JSONArray economicalArr2 = JSONArray.parseArray(economicalData42);
                    if (economicalArr2.size() > 1) {
                        for (int i = 0; i < economicalArr2.size(); i++) {
                            JSONArray jsonArray = economicalArr2.getJSONArray(i);
                            if (i == 0) {
                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                    String s = jsonArray.getString(i1);
                                    Cell cell = new Cell(new Phrase(s, font));
                                    cell.setBackgroundColor(new Color(221, 221, 221));
                                    cell.setUseAscender(true);
                                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                                    economicalTable42.addCell(cell);
                                }
                            } else {
                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                    String s = jsonArray.getString(i1);
                                    economicalTable42.addCell(createTableContentWord(s));
                                }
                            }
                        }
                        document.add(economicalTable42);
                    } else {
                        Paragraph economicalDataParagraph = createDataWord("暂无数据");
                        economicalDataParagraph.setFirstLineIndent(25);
                        document.add(economicalDataParagraph);
                    }
                }
            }*/
            //5、其他属性（共10分，得分：5.8分）
            document.add(createHeadWord(14, "5、其他属性（共" + guideMaxMap.get("其他属性") + "分，得分：" + otherAttributesScore + "分）", Element.ALIGN_LEFT));
            //5.1 国家医保
            document.add(createHeadSecondWord("5.1 国家医保（" + reimbursementListScore + "）"));
            Paragraph data51 = createDataWord(drugName + (reimbursementList ? "在国家医保目录中，属于医保" + reimbursement : "不在国家医保目录中。") + (reimbursementList ? (StringUtils.isNotBlank(paymentLimits) ? "，" + paymentLimits + ((StrUtil.endWith(paymentLimits, "。")) ? "" : "。") : "，无支付限制。") : ""));
            data51.setFirstLineIndent(25);
            document.add(data51);
            //5.2 国家基本药物
            char triangleSymbol = (char) 30;
            document.add(createHeadSecondWord("5.2 国家基本药物（" + essentialMedicinesScore + "）"));
            Paragraph data52 = createDataWord(drugName + (essentialMedicines ? "已被纳入国家基本药物目录" : "并未被纳入国家基本药物目录。") + (essentialMedicines ? (("").equals(otherAttributes.getString("essentialType")) ? "，无△" : "，有△") + otherAttributes.getString("essentialType") + "要求。" : ""));
            data52.setFirstLineIndent(25);
            document.add(data52);
            //5.3 国家集中采购药品
            document.add(createHeadSecondWord("5.3 国家集中采购药品（" + procurementOfDrugsScore + "）"));
            Paragraph data53 = createDataWord(drugName + (procurementOfDrugs ? "已被" : "并未被") + "列为国家集中采购药品。");
            data53.setFirstLineIndent(25);
            document.add(data53);
            //5.4 原研/参比/一致性评价
            assert otherAttributes != null;
            document.add(createHeadSecondWord("5.4 原研/参比/一致性评价（" + otherAttributes.getString("guideDrugSituationScore") + "）"));
            Paragraph data54 = createDataWord(otherAttributes.getString("guideDrugSituation"));
            data54.setFirstLineIndent(25);
            document.add(data54);
            //5.5 生成企业状况
            document.add(createHeadSecondWord("5.5 生产企业状况（" + otherAttributes.getString("guideEnterpriseScore") + "）"));
            Paragraph data55 = createDataWord(otherAttributes.getString("guideEnterprise"));
            data55.setFirstLineIndent(25);
            document.add(data55);
            //5.6 全球使用情况
            document.add(createHeadSecondWord("5.6 全球使用情况（" + otherAttributes.getString("guideCountryScore") + "）"));
            Paragraph data56 = createDataWord(otherAttributes.getString("guideCountry"));
            data56.setFirstLineIndent(25);
            document.add(data56);

//            if (otherAttributes != null) {
//                JSONArray otherTable = otherAttributes.getJSONArray("table");
//                if (otherTable != null) {
//                    String otherJson = otherTable.toJSONString();
//                    Table otherTable4 = new Table(5);
//                    JSONArray otherArr = JSONArray.parseArray(otherJson);
//                    if (otherArr.size() > 1) {
//                        for (int i = 0; i < otherArr.size(); i++) {
//                            JSONArray jsonArray = otherArr.getJSONArray(i);
//                            if (i == 0) {
//                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                    String s = jsonArray.getString(i1);
//                                    Cell cell = new Cell(new Phrase(s, font));
//                                    cell.setBackgroundColor(new Color(221, 221, 221));
//                                    cell.setUseAscender(true);
//                                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
//                                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
//                                    otherTable4.addCell(cell);
//                                }
//                            } else {
//                                for (int i1 = 0; i1 < jsonArray.size(); i1++) {
//                                    String s = jsonArray.getString(i1);
//                                    otherTable4.addCell(createTableContentWord(s));
//                                }
//                            }
//                        }
//                        document.add(otherTable4);
//                    }
//                }
//            }
            // 关闭文档，才能输出
            document.close();
            writer.close();
            log.info("----------指南报告下载完成----------");
        }
    }

}
