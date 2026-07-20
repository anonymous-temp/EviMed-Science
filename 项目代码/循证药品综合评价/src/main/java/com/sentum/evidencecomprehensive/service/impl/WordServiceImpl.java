package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.jcraft.jsch.*;
import com.lowagie.text.Font;
import com.lowagie.text.Image;
import com.lowagie.text.*;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.rtf.RtfWriter2;
import com.lowagie.text.rtf.field.RtfPageNumber;
import com.lowagie.text.rtf.field.RtfTotalPageNumber;
import com.lowagie.text.rtf.headerfooter.RtfHeaderFooter;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.EvidenceBasedReport;
import com.sentum.evidencecomprehensive.service.ReportService;
import com.sentum.evidencecomprehensive.service.WordService;
import com.sentum.evidencecomprehensive.utils.operateyl.CommonUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang.exception.ExceptionUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.*;

/**
 * @Description: 线下word
 */
@Slf4j
@Service
public class WordServiceImpl implements WordService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ReportService reportService;
    
    @Value("${sftp.host_129}")
    private String sftpHost;
    @Value("${sftp.port_129}")
    private Integer sftpPort;
    @Value("${sftp.userName_129}")
    private String sftpUserName;
    @Value("${sftp.password_129}")
    private String sftpPassword;
    @Value("${sftp.path_129}")
    private String sftpPath;
    @Override
    public void downloadEvidenceBasedReportWord(String id, String source, HttpServletResponse response) {
        try {
            //防止中文乱码
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            EvidenceBasedReport evidenceBasedReport = mongoTemplate.findById(id, EvidenceBasedReport.class, "evidence_based_report");
            String fileName = "";
            if (evidenceBasedReport != null) {
                String reportName = evidenceBasedReport.getTitle();
                if (StrUtil.isNotBlank(reportName)) {
                    reportName = reportName.replaceAll("\\*|/|\\?|\\.|\\..|\\$|&|<|>|\\+|\\^", "");
                    fileName = reportName + ".doc";
                } else {
                    fileName = "循证综合评价分析报告" + "_" + id + ".doc";
                }
            }
            response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
            ServletOutputStream outputStream = response.getOutputStream();
            this.createEvidenceBasedReportWord(id, source, outputStream);
            //ServletUtil.write(response, evidenceBasedReportWord);
            //删除服务器上的临时文件
            //log.info("循证综合评价报告临时文件删除==={}", evidenceBasedReportWord.delete());
        } catch (Exception e) {
            log.error("下载循证综合评价报告word版出现异常，{}", ExceptionUtils.getFullStackTrace(e));
        }
    }

    private void createEvidenceBasedReportWord(String id, String source, ServletOutputStream outputStream) {
        Document document = new Document(PageSize.A4);
        document.setMargins(50, 50, 50, 50);
        try {
            JSONObject evidenceBasedReport = mongoTemplate.findById(id, JSONObject.class, "evidence_based_report");
            if (evidenceBasedReport != null) {
                RtfWriter2 rtfWriter2 = RtfWriter2.getInstance(document, outputStream);
                rtfWriter2.setAutogenerateTOCEntries(true);

                // 加载 Logo 图片
//                Image logo = Image.getInstance("/Users/yyyyouhf/Desktop/入口/图片/1E299CA6C65CF7AB6C99782E8B970EA5.jpg");
                Image logo = this.readImage("/image/lingxi.jpg", "lingxi");
                
                // 设置 Logo 大小
                logo.scalePercent(10.0f, 10.0f);
                logo.setBackgroundColor(Color.red);
//                logo.scaleAbsolute(50, 50);
                // 创建 HeaderFooter 实例
                Paragraph paragraph = new Paragraph();
                paragraph.add(logo);
                HeaderFooter headerFooter = new HeaderFooter(paragraph, false);
                headerFooter.setAlignment(2);
                // 将 HeaderFooter 实例设置到 PdfWriter
                rtfWriter2.setHeader(headerFooter);
                
                document.open();
                //封面
                insertCover(evidenceBasedReport, source, document);
                // 循证报告正文
                evidenceMain(evidenceBasedReport, document);
                // 正文参考文献
                generateBibliography(evidenceBasedReport, document);
                // 附录
                //appendixList(evidenceBasedReport, document);
                // 质量评价附录
                //paperEditAppendix(evidenceBasedReport, document);
                // 页脚页码设置
                setPageNum(document);
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            log.error("生成超说明书循证综合评价报告word版出现异常，{}", ExceptionUtils.getFullStackTrace(e));
        } finally {
            document.close();
        }
    }

    /**
     * 二、卫生技术评估（HTA）报告正文
     */
    private void evidenceMain(JSONObject evidenceBasedReport, Document document) throws DocumentException {
        document.newPage();

        String background = evidenceBasedReport.getString("background");
        this.setTitleTwo("1、背景", document);
        if (StrUtil.isNotBlank(background)) {
            background = wiffOfContent(background, "\n\n", "\n");
            background = wiffOfContent(background, "<sup>", "");
            background = wiffOfContent(background, "</sup>", "");
            this.setNoRetractContentOne(background, document);
        } else {
            this.setNoRetractContentOne("暂无背景介绍", document);
        }


        int innerTitleCount = 1;
        JSONArray instructionInfos = evidenceBasedReport.getJSONArray("instructionInfos");
//        this.addBlank(document, 2);
        this.setTitleTwo("2、 待评价药品介绍", document);
        if (CollUtil.isNotEmpty(instructionInfos)) {
            for (Object o : instructionInfos) {
                int innerCount = 1;
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                Integer type = inner.getInteger("type");
                if (Objects.nonNull(type) && type == 1) {
                    String name = inner.getString("name");
                    this.setTitleTwo("【2."+ innerTitleCount++ +" 国内说明书" + name + "基本信息】", document);
                    if (CollUtil.isNotEmpty(inner.getJSONArray("indicationsDosage"))) {
                        JSONArray indicationsDosage = inner.getJSONArray("indicationsDosage");
                        this.setContentTitle("（"+ innerCount++ +"）适应症与用法用量：", document);
                        assembleListData(indicationsDosage, document);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("pharmacology"))) {
                        JSONArray pharmacology = inner.getJSONArray("pharmacology");
                        this.setContentTitle("（"+ innerCount++ +"）药理作用：", document);
                        assembleListData(pharmacology, document);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("pharmacokinetics"))) {
                        JSONArray pharmacokinetics = inner.getJSONArray("pharmacokinetics");
                        this.setContentTitle("（"+ innerCount +"）药代动力学：", document);
                        assembleListData(pharmacokinetics, document);
                    }
                } else {
                    String name = inner.getString("name");
                    this.setTitleTwo("【2."+ innerTitleCount++ +" 国内说明书" + name + "基本信息】", document);
                    if (CollUtil.isNotEmpty(inner.getJSONArray("indications"))) {
                        JSONArray indications = inner.getJSONArray("indications");
                        this.setContentTitle("（"+ innerCount++ +"）临床适应证：", document);
                        assembleListData(indications, document);
                    }
                    if (CollUtil.isNotEmpty(inner.getJSONArray("usageAndDosage"))) {
                        JSONArray usageAndDosage = inner.getJSONArray("usageAndDosage");
                        this.setContentTitle("（"+ innerCount++ +"）便利性与依从性（用法用量）：", document);
                        assembleListData(usageAndDosage, document);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("pharmacology"))) {
                        JSONArray pharmacology = inner.getJSONArray("pharmacology");
                        this.setContentTitle("（"+ innerCount++ +"）药理作用：", document);
                        assembleListData(pharmacology, document);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("pharmacokinetics"))) {
                        JSONArray pharmacokinetics = inner.getJSONArray("pharmacokinetics");
                        this.setContentTitle("（"+ innerCount +"）药代动力学：", document);
                        assembleListData(pharmacokinetics, document);
                    }
                }
            }
        } else {
            this.setContentOne("暂无相关国内说明书内容", document);
        }

        JSONArray otherInstructions = evidenceBasedReport.getJSONArray("otherInstructions");
        if (CollUtil.isNotEmpty(otherInstructions)) {
            for (Object o : otherInstructions) {
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                String drugName = inner.getString("drugName");
                this.setTitleTwo("【2."+ innerTitleCount +" 国外说明书" + drugName + "基本信息】", document);

                int innerSourceCount = 1;
                // fda 
                JSONObject fda = inner.getJSONObject("fda");
                if (Objects.nonNull(fda)) {
                    this.setRetractContentTitle("2."+ innerTitleCount +"."+ innerSourceCount++ +" FDA", document);
                    int innerInnerCount = 1;
                    JSONObject innerO = JSON.parseObject(JSON.toJSONString(fda), JSONObject.class);
                    if (StrUtil.isNotBlank(innerO.getString("indication"))) {
                        String indication = innerO.getString("indication");
                        this.setContentTitle("临床适应证：", document);
//                        this.setContentTitle("（"+ innerInnerCount++ +"）临床适应证：", document);
                        this.setContentOne(indication, document);
                    }
//                    if (StrUtil.isNotBlank(innerO.getString("usageAndDosage"))) {
//                        String usageAndDosage = innerO.getString("usageAndDosage");
//                        this.setContentTitle("（"+ innerInnerCount++ +"）用法用量：", document);
//                        this.setContentOne(usageAndDosage, document);
//                    }
//
//                    if (StrUtil.isNotBlank(innerO.getString("pharmacology"))) {
//                        String pharmacology = innerO.getString("pharmacology");
//                        this.setContentTitle("（"+ innerInnerCount++ +"）药理作用：", document);
//                        this.setContentOne(pharmacology, document);
//                    }
//
//                    if (StrUtil.isNotBlank(innerO.getString("pharmacokinetics"))) {
//                        String pharmacokinetics = innerO.getString("pharmacokinetics");
//                        this.setContentTitle("（"+ innerInnerCount +"）药代动力学：", document);
//                        this.setContentOne(pharmacokinetics, document);
//                    }
                }

                JSONObject ema = inner.getJSONObject("ema");
                if (Objects.nonNull(ema)) {
                    this.setRetractContentTitle("2."+ innerTitleCount +"."+ innerSourceCount++ +" EMA", document);
                    int innerInnerCount = 1;
                    JSONObject innerO = JSON.parseObject(JSON.toJSONString(ema), JSONObject.class);
                    if (StrUtil.isNotBlank(innerO.getString("indication"))) {
                        String indication = innerO.getString("indication");
//                        this.setContentTitle("（"+ innerInnerCount++ +"）临床适应证：", document);
                        this.setContentTitle("临床适应证：", document);
                        this.setContentOne(indication, document);
                    }
//                    if (StrUtil.isNotBlank(innerO.getString("usageAndDosage"))) {
//                        String usageAndDosage = innerO.getString("usageAndDosage");
//                        this.setContentTitle("（"+ innerInnerCount++ +"）用法用量：", document);
//                        this.setContentOne(usageAndDosage, document);
//                    }
//
//                    if (StrUtil.isNotBlank(innerO.getString("pharmacology"))) {
//                        String pharmacology = innerO.getString("pharmacology");
//                        this.setContentTitle("（"+ innerInnerCount++ +"）药理作用：", document);
//                        this.setContentOne(pharmacology, document);
//                    }
//
//                    if (StrUtil.isNotBlank(innerO.getString("pharmacokinetics"))) {
//                        String pharmacokinetics = innerO.getString("pharmacokinetics");
//                        this.setContentTitle("（"+ innerInnerCount +"）药代动力学：", document);
//                        this.setContentOne(pharmacokinetics, document);
//                    }
                }

//                JSONObject pmda = inner.getJSONObject("pmda");
//                if (Objects.nonNull(pmda)) {
//                    this.setRetractContentTitle("2."+ innerTitleCount +"."+ innerSourceCount +" PMDA", document);
//                    int innerInnerCount = 1;
//                    JSONObject innerO = JSON.parseObject(JSON.toJSONString(pmda), JSONObject.class);
//                    if (StrUtil.isNotBlank(innerO.getString("indication"))) {
//                        String indication = innerO.getString("indication");
////                        this.setContentTitle("（"+ innerInnerCount++ +"）临床适应证：", document);
//                        this.setContentTitle("临床适应证：", document);
//                        this.setContentOne(indication, document);
//                    }
////                    if (StrUtil.isNotBlank(innerO.getString("usageAndDosage"))) {
////                        String usageAndDosage = innerO.getString("usageAndDosage");
////                        this.setContentTitle("（"+ innerInnerCount++ +"）用法用量：", document);
////                        this.setContentOne(usageAndDosage, document);
////                    }
////
////                    if (StrUtil.isNotBlank(innerO.getString("pharmacology"))) {
////                        String pharmacology = innerO.getString("pharmacology");
////                        this.setContentTitle("（"+ innerInnerCount++ +"）药理作用：", document);
////                        this.setContentOne(pharmacology, document);
////                    }
////
////                    if (StrUtil.isNotBlank(innerO.getString("pharmacokinetics"))) {
////                        String pharmacokinetics = innerO.getString("pharmacokinetics");
////                        this.setContentTitle("（"+ innerInnerCount +"）药代动力学：", document);
////                        this.setContentOne(pharmacokinetics, document);
////                    }
//                }
                innerTitleCount ++;
            }
        } else {
            this.setContentOne("暂无国内外说明书内容。", document);
        }

        this.setTitleTwo("3、对照药品", document);
        JSONArray cb = evidenceBasedReport.getJSONArray("cb");
        if (CollUtil.isNotEmpty(cb)) {
            for (Object o : cb) {
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                String title = inner.getString("title");
                setContentOne(title, document);

                String drugName = inner.getString("drugName");
                setContentCenter(drugName + "与其它药品对比结果", document);

                JSONArray table = inner.getJSONArray("table");
                if (CollUtil.isNotEmpty(table)) {
                    createTableForDrugComparison(table, document);

                }       
            }
        } else {
            setContentOne("暂无对照药品内容。", document);
        }

//        this.addBlank(document, 2);
        this.setTitleTwo("4、有效性", document);
        this.setTitleTwo("【4.1 国内外指南/共识】", document);
        JSONArray guide = evidenceBasedReport.getJSONArray("guide");
        if (CollUtil.isNotEmpty(guide)) {
            int innerCount = 1;
            for (Object o : guide) {
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                String title = inner.getString("title");
                String data = inner.getString("data");
                this.setNoRetractContentOne("（"+ innerCount++ +"）" + title, document);
                this.setRetractContentTitle(data, document);
            }
        } else {
            this.setNoRetractContentOne("暂无国内外指南/共识相关内容。", document);
        }

        this.setTitleTwo("【4.2 国内外文献】", document);
        JSONObject literature = evidenceBasedReport.getJSONObject("literature");
        Boolean literatureUseAI = evidenceBasedReport.getBoolean("literatureUseAI");
        if (Objects.nonNull(literature) && Objects.nonNull(literature.getJSONObject("safety"))) {
            
            JSONObject safety = literature.getJSONObject("safety");
            String effectiveTitle = safety.getString("effectiveTitle");
            this.setContentTitle(effectiveTitle, document);
            
            if (Objects.nonNull(literatureUseAI) && literatureUseAI) {
                int innerCount = 1;
                
                Boolean metaExists = safety.getBoolean("metaExists");
                if (metaExists) {
                    this.setContentTitle("4.2." + innerCount++ + " 系统综述/Meta分析", document);
                    String metaTitle = safety.getString("metaTitle");
                    String metaTitleContent = safety.getString("metaTitleContent");
                    setContentOne(metaTitle, document);
                    setContentOne(metaTitleContent, document);
                }

                Boolean rctExists = safety.getBoolean("rctExists");
                if (rctExists) {
                    this.setContentTitle("4.2." + innerCount++ + " 随机对照试验（RCT）和临床试验", document);
                    String rctTitle = safety.getString("rctTitle");
                    String rctTitleContent = safety.getString("rctTitleContent");
                    setContentOne(rctTitle, document);
                    setContentOne(rctTitleContent, document);
                }


                Boolean observeExists = safety.getBoolean("observeExists");
                if (observeExists) {
                    this.setContentTitle("4.2." + innerCount++ + " 观察性研究", document);
                    String observeTitle = safety.getString("observeTitle");
                    String observeTitleContent = safety.getString("observeTitleContent");
                    setContentOne(observeTitle, document);
                    setContentOne(observeTitleContent, document);
                }

                Boolean otherExists = safety.getBoolean("otherExists");
                if (otherExists) {
                    this.setContentTitle("4.2." + innerCount++ + " 其他", document);
                    String otherTitle = safety.getString("otherTitle");
                    String otherTitleContent = safety.getString("otherTitleContent");
                    setContentOne(otherTitle, document);
                    setContentOne(otherTitleContent, document);
                }
            } else {
                JSONArray safetyResult = safety.getJSONArray("safetyResult");
                if (CollUtil.isNotEmpty(safetyResult)) {
                    for (Object o : safetyResult) {
                        setNoRetractContentOne(o.toString(), document);
                    }
                }

                int innerCount = 1;
                JSONArray metaLiteratureDataTableEn = safety.getJSONArray("metaLiteratureDataTableEn");
                JSONArray metaLiteratureDataTableZh = safety.getJSONArray("metaLiteratureDataTableZh");
                if ((CollUtil.isNotEmpty(metaLiteratureDataTableZh) && metaLiteratureDataTableZh.size() > 1)
                        || (CollUtil.isNotEmpty(metaLiteratureDataTableEn) && metaLiteratureDataTableEn.size() > 1)) {
                    this.setContentTitle("4.2." + innerCount++ + " 系统综述/Meta分析", document);
                    if (CollUtil.isNotEmpty(metaLiteratureDataTableEn) && metaLiteratureDataTableEn.size() > 1) {
                        this.setContentCenter("英文文献", document);
                        createTableForLiteratureEnDataTable(metaLiteratureDataTableEn, document);
                    }
                    if (CollUtil.isNotEmpty(metaLiteratureDataTableZh) && metaLiteratureDataTableZh.size() > 1) {
                        this.setContentCenter("中文文献", document);
                        createTableForLiteratureZhDataTable(metaLiteratureDataTableZh, document);
                    }
                }
                JSONArray rctLiteratureDataTableEn = safety.getJSONArray("rctLiteratureDataTableEn");
                JSONArray rctLiteratureDataTableZh = safety.getJSONArray("rctLiteratureDataTableZh");
                if ((CollUtil.isNotEmpty(rctLiteratureDataTableEn) && rctLiteratureDataTableEn.size() > 1)
                        || (CollUtil.isNotEmpty(rctLiteratureDataTableZh) && rctLiteratureDataTableZh.size() > 1)) {
                    this.setContentTitle("4.2." + innerCount++ + " 随机对照试验（RCT）和临床试验", document);
                    if (CollUtil.isNotEmpty(rctLiteratureDataTableEn) && rctLiteratureDataTableEn.size() > 1) {
                        this.setContentCenter("英文文献", document);
                        createTableForLiteratureEnDataTable(rctLiteratureDataTableEn, document);
                    }
                    if (CollUtil.isNotEmpty(rctLiteratureDataTableZh) && rctLiteratureDataTableZh.size() > 1) {
                        this.setContentCenter("中文文献", document);
                        createTableForLiteratureZhDataTable(rctLiteratureDataTableZh, document);
                    }
                }
                JSONArray observeLiteratureDataTableEn = safety.getJSONArray("observeLiteratureDataTableEn");
                JSONArray observeLiteratureDataTableZh = safety.getJSONArray("observeLiteratureDataTableZh");
                if ((CollUtil.isNotEmpty(observeLiteratureDataTableEn) && observeLiteratureDataTableEn.size() > 1)
                        || (CollUtil.isNotEmpty(observeLiteratureDataTableZh) && observeLiteratureDataTableZh.size() > 1)) {
                    this.setContentTitle("4.2." + innerCount++ + " 观察性研究", document);
                    if (CollUtil.isNotEmpty(observeLiteratureDataTableEn) && observeLiteratureDataTableEn.size() > 1) {
                        this.setContentCenter("英文文献", document);
                        createTableForLiteratureEnDataTable(observeLiteratureDataTableEn, document);
                    }
                    if (CollUtil.isNotEmpty(observeLiteratureDataTableZh) && observeLiteratureDataTableZh.size() > 1) {
                        this.setContentCenter("中文文献", document);
                        createTableForLiteratureZhDataTable(observeLiteratureDataTableZh, document);
                    }
                }
                JSONArray otherLiteratureDataTableEn = safety.getJSONArray("otherLiteratureDataTableEn");
                JSONArray otherLiteratureDataTableZh = safety.getJSONArray("otherLiteratureDataTableZh");
                if ((CollUtil.isNotEmpty(otherLiteratureDataTableEn) && otherLiteratureDataTableEn.size() > 1)
                        || (CollUtil.isNotEmpty(otherLiteratureDataTableZh) && otherLiteratureDataTableZh.size() > 1)) {
                    this.setContentTitle("4.2." + innerCount++ + "  其他", document);
                    if (CollUtil.isNotEmpty(otherLiteratureDataTableEn) && otherLiteratureDataTableEn.size() > 1) {
                        this.setContentCenter("英文文献", document);
                        createTableForLiteratureEnDataTable(otherLiteratureDataTableEn, document);
                    }
                    if (CollUtil.isNotEmpty(otherLiteratureDataTableZh) && otherLiteratureDataTableZh.size() > 1) {
                        this.setContentCenter("中文文献", document);
                        createTableForLiteratureZhDataTable(otherLiteratureDataTableZh, document);
                    }
                }
            }
        } 
        
        
        

//        this.addBlank(document, 2);
        this.setTitleTwo("【4.3 其他国家或地区HTA组织评估情况】", document);
        JSONObject hta = evidenceBasedReport.getJSONObject("hta");
        if (Objects.nonNull(hta) && Objects.nonNull(hta.getJSONObject("effectiveness"))) {
            JSONObject effectiveness = hta.getJSONObject("effectiveness");
            if (Objects.nonNull(effectiveness.getString("hint"))) {
                setContentOne(effectiveness.getString("hint"), document);
            } else {
                JSONObject nice = effectiveness.getJSONObject("NICE");
                if (Objects.nonNull(nice)) {
                    String title = nice.getString("title");
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = nice.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject smc = effectiveness.getJSONObject("SMC");
                if (Objects.nonNull(smc)) {
                    String title = smc.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = smc.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject awmsg = effectiveness.getJSONObject("AWMSG");
                if (Objects.nonNull(awmsg)) {
                    String title = awmsg.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = awmsg.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject cadth = effectiveness.getJSONObject("CADTH");
                if (Objects.nonNull(cadth)) {
                    String title = cadth.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = cadth.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject eUnetHTA = effectiveness.getJSONObject("EUnetHTA");
                if (Objects.nonNull(eUnetHTA)) {
                    String title = eUnetHTA.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = eUnetHTA.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject inahta = effectiveness.getJSONObject("INAHTA");
                if (Objects.nonNull(inahta)) {
                    String title = inahta.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = inahta.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject pbac = effectiveness.getJSONObject("PBAC");
                if (Objects.nonNull(pbac)) {
                    String title = pbac.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = pbac.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
            }
        }

//        this.addBlank(document, 2);
        this.setTitleTwo("5、安全性", document);
        int innerCount = 1;
        if (CollUtil.isNotEmpty(instructionInfos)) {
            for (Object o : instructionInfos) {
                int cellCount = 1;
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                Integer type = inner.getInteger("type");
                String name = inner.getString("name");
                this.setTitleTwo("【5." + innerCount + " " + name + "国内说明书】", document);
                JSONArray warning = inner.getJSONArray("warning");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 黑框警告", document);
                if (CollUtil.isNotEmpty(warning)) {
                    assembleListData(warning, document);
                } else {
                    this.setContentOne("药品说明书中未提到黑框警告信息", document);
                }
//                if (Objects.nonNull(type) && type == 1) {
//                    JSONArray childrenAndGeriatricMedicine = inner.getJSONArray("childrenAndGeriatricMedicine");
//                    this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 儿童患者用药", document);
//                    if (CollUtil.isNotEmpty(childrenAndGeriatricMedicine)) {
//                        assembleListData(childrenAndGeriatricMedicine, document);
//                    } else {
//                        this.setContentOne("药品说明书中未提到儿童与老人用药信息", document);
//                    }
//                } else {
//                    JSONArray childrenMedicine = inner.getJSONArray("childrenMedicine");
//                    this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 儿童用药", document);
//                    if (CollUtil.isNotEmpty(childrenMedicine)) {
//                        assembleListData(childrenMedicine, document);
//                    } else {
//                        this.setContentOne("药品说明书中未提到儿童用药信息", document);
//                    }
//
//                    JSONArray geriatricMedicine = inner.getJSONArray("geriatricMedicine");
//                    this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 老人用药", document);
//                    if (CollUtil.isNotEmpty(geriatricMedicine)) {
//                        assembleListData(geriatricMedicine, document);
//                    } else {
//                        this.setContentOne("药品说明书中未提到老人用药信息", document);
//                    }
//                }
                JSONArray childrenMedicine = inner.getJSONArray("children");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 儿童用药", document);
                if (CollUtil.isNotEmpty(childrenMedicine)) {
                    assembleListData(childrenMedicine, document);
                } else {
                    this.setContentOne("药品说明书中未提到儿童用药信息", document);
                }

                JSONArray geriatricMedicine = inner.getJSONArray("geriatric");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 老人用药", document);
                if (CollUtil.isNotEmpty(geriatricMedicine)) {
                    assembleListData(geriatricMedicine, document);
                } else {
                    this.setContentOne("药品说明书中未提到老人用药信息", document);
                }
                
                JSONArray pregnantWomen = inner.getJSONArray("pregnantWomen");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 孕妇及哺乳期妇女用药", document);
                if (CollUtil.isNotEmpty(pregnantWomen)) {
                    assembleListData(pregnantWomen, document);
                } else {
                    this.setContentOne("药品说明书中未提到孕妇及哺乳期妇女用药信息", document);
                }
                JSONArray taboo = inner.getJSONArray("taboo");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 禁忌症", document);
                if (CollUtil.isNotEmpty(taboo)) {
                    assembleListData(taboo, document);
                } else {
                    this.setContentOne("药品说明书中未提到禁忌症信息", document);
                }

                JSONArray notes = inner.getJSONArray("notes");
                this.setContentTitle("  5." + innerCount + "." + cellCount++ + " 注意事项", document);
                if (CollUtil.isNotEmpty(notes)) {
                    assembleListData(notes, document);
                } else {
                    this.setContentOne("药品说明书中未提到注意事项信息", document);
                }

                JSONArray adverseReaction = inner.getJSONArray("adverseReaction");
                this.setContentTitle("  5." + innerCount + "." + cellCount + " 相互作用", document);
                if (CollUtil.isNotEmpty(adverseReaction)) {
                    assembleListData(adverseReaction, document);
                } else {
                    this.setContentOne("药品说明书中未提到相互作用信息", document);
                }
                innerCount ++;
            }
        }
        
//        this.addBlank(document, 2);
        this.setTitleTwo("【5." + innerCount + " 真实世界-FAERS数据库】", document);
        JSONObject showDBAnalysis = evidenceBasedReport.getJSONObject("showDBAnalysis");
        JSONObject signalAnalysis = showDBAnalysis.getJSONObject("signalAnalysis");
        JSONObject adverseAnalysis = showDBAnalysis.getJSONObject("adverseAnalysis");
        if (Objects.nonNull(signalAnalysis)) {
            String signalAnalysis_str = signalAnalysis.getString("signalAnalysis_str");
            if (StrUtil.isNotBlank(signalAnalysis_str)) {
                this.setContentOne(signalAnalysis_str, document);
            }
        }

        int faersCount = 1;
        if (Objects.nonNull(adverseAnalysis)) {
            JSONArray ptList = adverseAnalysis.getJSONArray("ptList");
            if (CollUtil.isNotEmpty(ptList)) {
                this.setContentTitle("5." + innerCount + "." + faersCount++ + " 常见不良反应分析（TOP10）", document);
                this.setContentCenter("其常见不良反应分析TOP10结果如下", document);
                createTableForAdverseAnalysis(ptList, document);
            }        
        } 

        if (Objects.nonNull(signalAnalysis)) {
            JSONObject signalAnalysis1 = signalAnalysis.getJSONObject("signalAnalysis");
            if (Objects.nonNull(signalAnalysis1)) {
                JSONArray data = signalAnalysis1.getJSONArray("data");
                if (CollUtil.isNotEmpty(data)) {
                    this.setContentTitle("5." + innerCount + "." + faersCount + " 典型信号挖掘（TOP10）", document);
                    String info = signalAnalysis1.getString("info");
                    this.setContentOne(info, document);
                    this.setContentCenter("其典型信号TOP10结果如下", document);
                    this.createTableForDBAnalysis(data, document);
                }
            } 
        } 
        innerCount++;

//        this.addBlank(document, 2);
        this.setTitleTwo("【5." + innerCount + " 其他国家或地区HTA组织评估情况】", document);
        if (Objects.nonNull(hta) && Objects.nonNull(hta.getJSONObject("security"))) {
            JSONObject security = hta.getJSONObject("security");
            if (Objects.nonNull(security.getString("hint"))) {
                setContentOne(security.getString("hint"), document);
            } else {
                JSONObject nice = security.getJSONObject("NICE");
                if (Objects.nonNull(nice)) {
                    String title = nice.getString("title");
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = nice.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject smc = security.getJSONObject("SMC");
                if (Objects.nonNull(smc)) {
                    String title = smc.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = smc.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject awmsg = security.getJSONObject("AWMSG");
                if (Objects.nonNull(awmsg)) {
                    String title = awmsg.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = awmsg.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject cadth = security.getJSONObject("CADTH");
                if (Objects.nonNull(cadth)) {
                    String title = cadth.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = cadth.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject eUnetHTA = security.getJSONObject("EUnetHTA");
                if (Objects.nonNull(eUnetHTA)) {
                    String title = eUnetHTA.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = eUnetHTA.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject inahta = security.getJSONObject("INAHTA");
                if (Objects.nonNull(inahta)) {
                    String title = inahta.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = inahta.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject pbac = security.getJSONObject("PBAC");
                if (Objects.nonNull(pbac)) {
                    String title = pbac.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = pbac.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
            }
        }
        innerCount++;

//        this.addBlank(document, 2);
        this.setTitleTwo("【5." + innerCount + " 药物警戒】", document);
        JSONObject showPolicyAnalysis = evidenceBasedReport.getJSONObject("showPolicyAnalysis");
        int belongCount = 1;
        if (Objects.nonNull(showPolicyAnalysis)
                && Objects.nonNull(showPolicyAnalysis.getJSONObject("policyAnalysis"))) {
            JSONObject policyAnalysis = showPolicyAnalysis.getJSONObject("policyAnalysis");
            
            JSONArray nmpaWord = policyAnalysis.getJSONArray("nmpaWord");
            int ywjjNmpaCount = 1;
            if (CollUtil.isNotEmpty(nmpaWord)) {
                this.setContentTitle("5." + innerCount + "." + belongCount + " NMPA药物警戒：", document);
                if (nmpaWord.size() == 1) {
                    for (Object o : nmpaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjNmpaCount + " " + analysis, document);
                    }
                } else {
                    for (Object o : nmpaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        analysis = analysis.substring(1);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjNmpaCount + " " + analysis, document);
                        ywjjNmpaCount ++;
                    }
                }
                belongCount++;
            } else {
                this.setContentTitle("5." + innerCount + "." + belongCount + " NMPA药物警戒：", document);
                this.setContentOne("NMPA未收录" + policyAnalysis.getString("drugName") + "相关的安全警示信息。", document);
                belongCount++;
            }

            JSONArray fdaWord = policyAnalysis.getJSONArray("fdaWord");
            int ywjjFdaCount = 1;
            if (CollUtil.isNotEmpty(fdaWord)) {
                this.setContentTitle("5." + innerCount + "." + belongCount + " FDA药物警戒：", document);
                if (fdaWord.size() == 1) {
                    for (Object o : fdaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjFdaCount + " " + analysis, document);
                    }
                } else {
                    for (Object o : fdaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        analysis = analysis.substring(1);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjFdaCount + " " + analysis, document);
                        ywjjFdaCount ++;
                    }
                }
                belongCount++;
            } else {
                this.setContentTitle("5." + innerCount + "." + belongCount + " FDA药物警戒：", document);
                this.setContentOne("FDA未收录" + policyAnalysis.getString("drugName") + "相关的安全警示信息。", document);
                belongCount++;
            }

            JSONArray emaWord = policyAnalysis.getJSONArray("emaWord");
            int ywjjEmaCount = 1;
            if (CollUtil.isNotEmpty(emaWord)) {
                this.setContentTitle("5." + innerCount + "." + belongCount + " EMA药物警戒：", document);
                if (emaWord.size() == 1) {
                    for (Object o : emaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjEmaCount + " " + analysis, document);
                    }
                } else {
                    for (Object o : emaWord) {
                        String analysis = JSON.parseObject(JSON.toJSONString(o), String.class);
                        analysis = analysis.substring(1);
                        this.setContentOne("5." + innerCount + "." + belongCount + "." + ywjjEmaCount + " " + analysis, document);
                        ywjjEmaCount ++;
                    }
                }
            } else {
                this.setContentTitle("5." + innerCount + "." + belongCount + " EMA药物警戒：", document);
                this.setContentOne("EMA未收录" + policyAnalysis.getString("drugName") + "相关的安全警示信息。", document);
                belongCount++;
            }
        } else {
            this.setContentOne("暂无药物警戒内容", document);
        }


//        this.addBlank(document, 2);
        this.setTitleTwo("6、经济性", document);
        this.setTitleTwo("【6.1 国内外文献】", document);
        if (Objects.nonNull(literature) && Objects.nonNull(literature.getJSONObject("economy"))) {
            JSONObject economy = literature.getJSONObject("economy");
            if (Objects.nonNull(literatureUseAI) && literatureUseAI) {
                String economySummeryTitle = economy.getString("economySummeryTitle");
                this.setContentTitle(economySummeryTitle, document);
                
                Boolean economyExists = economy.getBoolean("economyExists");
                if (economyExists) {
                    String economyTitle = economy.getString("economyTitle");
                    String economyTitleContent = economy.getString("economyTitleContent");
                    setContentOne(economyTitle, document);
                    setContentOne(economyTitleContent, document);
                }
            } else {
                JSONArray economyResult = economy.getJSONArray("economyResult");
                if (CollUtil.isNotEmpty(economyResult)) {
                    for (Object o : economyResult) {
                        setNoRetractContentOne(o.toString(), document);
                    }
                }

                JSONArray economyLiteratureDataTableEn = economy.getJSONArray("economyLiteratureDataTableEn");
                JSONArray economyLiteratureDataTableZh = economy.getJSONArray("economyLiteratureDataTableZh");
                if ((CollUtil.isNotEmpty(economyLiteratureDataTableEn) && economyLiteratureDataTableEn.size() > 1)
                        || (CollUtil.isNotEmpty(economyLiteratureDataTableZh) && economyLiteratureDataTableZh.size() > 1)) {
                    if (CollUtil.isNotEmpty(economyLiteratureDataTableEn) && economyLiteratureDataTableEn.size() > 1) {
                        this.setContentCenter("英文文献", document);
                        createTableForLiteratureEnDataTable(economyLiteratureDataTableEn, document);
                    }
                    if (CollUtil.isNotEmpty(economyLiteratureDataTableZh) && economyLiteratureDataTableZh.size() > 1) {
                        this.setContentCenter("中文文献", document);
                        createTableForLiteratureZhDataTable(economyLiteratureDataTableZh, document);
                    }
                }
            }
        }

//        this.addBlank(document, 2);
        this.setTitleTwo("【6.2 其他国家或地区HTA组织评估情况】", document);
        if (Objects.nonNull(hta) && Objects.nonNull(hta.getJSONObject("economicViability"))) {
            JSONObject economicViability = hta.getJSONObject("economicViability");
            if (Objects.nonNull(economicViability.getString("hint"))) {
                setContentOne(economicViability.getString("hint"), document);
            } else {
                JSONObject nice = economicViability.getJSONObject("NICE");
                if (Objects.nonNull(nice)) {
                    String title = nice.getString("title");
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = nice.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject smc = economicViability.getJSONObject("SMC");
                if (Objects.nonNull(smc)) {
                    String title = smc.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = smc.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject awmsg = economicViability.getJSONObject("AWMSG");
                if (Objects.nonNull(awmsg)) {
                    String title = awmsg.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = awmsg.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject cadth = economicViability.getJSONObject("CADTH");
                if (Objects.nonNull(cadth)) {
                    String title = cadth.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = cadth.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject eUnetHTA = economicViability.getJSONObject("EUnetHTA");
                if (Objects.nonNull(eUnetHTA)) {
                    String title = eUnetHTA.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = eUnetHTA.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject inahta = economicViability.getJSONObject("INAHTA");
                if (Objects.nonNull(inahta)) {
                    String title = inahta.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = inahta.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
                JSONObject pbac = economicViability.getJSONObject("PBAC");
                if (Objects.nonNull(pbac)) {
                    String title = pbac.getString("title");
//                    addBlank(document, 1);
                    setNoRetractContentOneBord(title, document);
                    JSONArray table = pbac.getJSONArray("table");
                    for (Object o : table) {
                        String str = o.toString();
                        str = wiffOfContent(str, "\n\n", "\n");
                        setNoRetractContentOne(str, document);
                    }
                }
            }
        }


        Session jschSession = null;
        ChannelSftp channelSftp = null;
        try {
            JSch jsch = new JSch();
            jschSession = jsch.getSession(sftpUserName, sftpHost, sftpPort);
            // 通过密码的方式登录认证
            jschSession.setPassword(sftpPassword);
            Properties properties = new Properties();
            properties.put("StrictHostKeyChecking", "no");
            jschSession.setConfig(properties);
            jschSession.connect(Constants.SESSION_TIMEOUT);
            // 建立sftp文件传输管道
            Channel sftp = jschSession.openChannel("sftp");
            sftp.connect(Constants.CHANNEL_TIMEOUT);
            channelSftp = (ChannelSftp) sftp;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        } finally {

            //todo 需要释放连接
        }

//        this.addBlank(document, 2);
        int cdeCoutnt = 1;
        this.setTitleTwo("7、国家药品监督管理局药品审评中心", document);
        JSONObject cde = evidenceBasedReport.getJSONObject("cde");
        if (Objects.nonNull(cde)) {
            if (CollUtil.isNotEmpty(cde.getJSONArray("cdeArrays"))) {
                JSONArray cdeArrays = cde.getJSONArray("cdeArrays");
                for (Object o : cdeArrays) {
                    int innerCdeCount = 1;
                    JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                    String name = inner.getString("name");
                    this.setTitleTwo("【7."+ cdeCoutnt++ + " " + name +"】", document);

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordIndication"))) {
                        JSONArray wordIndication = inner.getJSONArray("wordIndication");
                        this.setContentTitle("（"+ innerCdeCount++ +"）" + "适应证：", document);
                        assembleHtaListData(wordIndication, document, channelSftp);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordEffective"))) {
                        JSONArray wordEffective = inner.getJSONArray("wordEffective");
                        this.setContentTitle("（"+ innerCdeCount++ +"）" + "有效性：", document);
                        assembleHtaListData(wordEffective, document, channelSftp);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordSafety"))) {
                        JSONArray wordSafety = inner.getJSONArray("wordSafety");
                        this.setContentTitle("（"+ innerCdeCount++ +"）" + "安全性：", document);
                        assembleHtaListData(wordSafety, document, channelSftp);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordConclusion"))) {
                        JSONArray wordConclusion = inner.getJSONArray("wordConclusion");
                        this.setContentTitle("（"+ innerCdeCount++ +"）" + "获益与风险评估：", document);
                        assembleHtaListData(wordConclusion, document, channelSftp);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordTecConclusion"))) {
                        JSONArray wordTecConclusion = inner.getJSONArray("wordTecConclusion");
                        this.setContentTitle("（"+ innerCdeCount++ +"）" + "技术总结：", document);
                        assembleHtaListData(wordTecConclusion, document, channelSftp);
                    }

                    if (CollUtil.isNotEmpty(inner.getJSONArray("wordAspect"))) {
                        JSONArray wordAspect = inner.getJSONArray("wordAspect");
                        this.setContentTitle("（"+ innerCdeCount +"）" + "临床方面：", document);
                        assembleHtaListData(wordAspect, document, channelSftp);
                    }
                } 
            } else {
                this.setContentOne(cde.getString("hint"), document);
            }
            
        } 

//        this.addBlank(document, 2);
        this.setTitleTwo("8、其他属性", document);
        JSONArray otherSourceDrugInfo = evidenceBasedReport.getJSONArray("otherSourceDrugInfo");
        if (CollUtil.isNotEmpty(otherSourceDrugInfo)) {
            for (Object o : otherSourceDrugInfo) {
                int innerOtherCount = 1;
                JSONObject inner = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);

                this.setTitleTwo("【8."+ innerOtherCount++ + " 国家医保】", document);
                String medicalInsurance = inner.getString("medicalInsurance");
                if (StrUtil.isNotBlank(medicalInsurance)) {
                    setContentOne(medicalInsurance, document);
                } else {
                    setContentOne("暂无内容", document);
                }

//                this.addBlank(document, 2);
                this.setTitleTwo("【8."+ innerOtherCount++ + " 国家基本药物】", document);
                JSONObject essentialMedicines = inner.getJSONObject("essentialMedicines");
                String title = essentialMedicines.getString("title");
                setContentOne(title, document);
                String con = essentialMedicines.getString("con");
                if (StrUtil.isNotBlank(con)) {
                    setContentOne(con, document);
                }

//                this.addBlank(document, 2);
                this.setTitleTwo("【8."+ innerOtherCount++ + " 国家集采药品】", document);
                String drugCollection = inner.getString("drugCollection");
                if (StrUtil.isNotBlank(drugCollection)) {
                    setContentOne(drugCollection, document);
                } else {
                    setContentOne("暂无内容", document);
                }

//                this.addBlank(document, 2);
                JSONArray storage = inner.getJSONArray("storage");
                this.setTitleTwo("【8."+ innerOtherCount + " 贮藏条件】", document);
                if (CollUtil.isNotEmpty(storage)) {
                    assembleListData(storage, document);
                } else {
                    setContentOne("暂无内容", document);
                }
            }
        } else {
            this.setContentOne("暂无其他属性信息", document);
        }
        
//        this.setTitleTwo("8、总结", document);
//        evidenceBasedReport.get
    }



    /**
     * 封面
     */
    private void insertCover(JSONObject evidenceBasedReport, String source, Document document) throws DocumentException {
        // 先空出7行
        this.addBlank(document, 7);
        //设置标题及上下线
        Paragraph title = new Paragraph(evidenceBasedReport.getString("title"));
        Font blankSize = new Font(null, 24, Font.BOLD);
//        try {
//            blankSize = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 24, Font.BOLD);
//        } catch (IOException e) {
//            blankSize = new Font(null, 24, Font.BOLD);
//        }
        title.setFont(blankSize);
        title.setAlignment(1);
        document.add(title);

        if ("app".equals(source)) {
            this.addBlank(document, 16);
            this.setContentCenter("灵犀量子（北京）医疗科技有限公司", document);
            LocalDate now = LocalDate.now();
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
            String format = formatter.format(now);
            this.setContentCenter(format, document);
//            this.addBlank(document, 1);
            this.setContentAi("本报告包含由 EviMed 模型 AI 生成的内容", document);
        } else {
            this.addBlank(document, 28);
            this.setContentCenter("灵犀量子（北京）医疗科技有限公司", document);
            LocalDate now = LocalDate.now();
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
            String format = formatter.format(now);
            this.setContentCenter(format, document);
//            this.addBlank(document, 1);
            this.setContentAi("本报告包含由 EviMed 模型 AI 生成的内容", document);
        }
    }

    
    

    /**
     * 一级标题
     */
    private void setTitleOne(String value, Document document) throws DocumentException {
        Font title1Font;
        try {
            title1Font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 14, Font.BOLD);
        } catch (IOException e) {
            title1Font = new Font(null, 14, Font.BOLD);
        }
        Paragraph title0 = new Paragraph(value);
        title0.setAlignment(Element.ALIGN_LEFT);
        //设置段前段后间距
        title0.setSpacingBefore(20f);
        title0.setFont(title1Font);
        document.add(title0);
    }

    /**
     * 二级标题
     */
    private void setTitleTwo(String value, Document document) throws DocumentException {
        Font title2Font = new Font(null, 14, Font.BOLD);;
//        try {
//            title2Font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 14, Font.BOLD);
//        } catch (IOException e) {
//            title2Font = new Font(null, 14, Font.BOLD);
//        }
        Paragraph title2 = new Paragraph(value);
        title2.setAlignment(Element.ALIGN_LEFT);
        //设置段前段后间距
        title2.setSpacingBefore(5f);
        title2.setSpacingAfter(8f);
        title2.setFont(title2Font);
        document.add(title2);
    }

    /**
     * 一级内容
     */
    private void setContentOne(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL); ;
//        try {
//            font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 12, Font.NORMAL);
//        } catch (IOException e) {
//            font = new Font(null, 12, Font.NORMAL);
//        }
        Paragraph content = new Paragraph(value);
        //首行缩进
        content.setFirstLineIndent(25f);
        // 段前间距
        content.setSpacingBefore(6f);
        //行间距
        content.setLeading(18f);
        //字体
        content.setFont(font);
        document.add(content);
    }
    
    /**
     * 一级内容
     */
    private void setNoRetractContentOne(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL); ;
//        try {
//            font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 12, Font.NORMAL);
//        } catch (IOException e) {
//            font = new Font(null, 12, Font.NORMAL);
//        }
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setSpacingBefore(6f);
        content.setSpacingAfter(6f);
        //行间距
        content.setLeading(18f);
        //字体
        content.setFont(font);
        document.add(content);
    }

    /**
     * 一级内容
     */
    private void setNoRetractContentOneBord(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.BOLD); ;
//        try {
//            font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 12, Font.NORMAL);
//        } catch (IOException e) {
//            font = new Font(null, 12, Font.NORMAL);
//        }
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setSpacingBefore(6f);
        content.setSpacingAfter(6f);
        //行间距
        content.setLeading(18f);
        //字体
        content.setFont(font);
        document.add(content);
    }


    /**
     * 右侧小标题显示
     */
    private void setContentRight(String value, Document document) throws DocumentException {
        Font font = new Font(null, 8, Font.NORMAL);
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setIndentationRight(5f);
        content.setAlignment(2);
        content.setFont(font);
        document.add(content);
    }

    /**
     * 右侧小标题显示
     */
    private void setContentAi(String value, Document document) throws DocumentException {
        Font font = new Font(null, 10, Font.NORMAL, Color.GRAY);
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setSpacingBefore(5f);
        content.setIndentationRight(5f);
        content.setAlignment(1);
        content.setFont(font);
        document.add(content);
    }

    /**
     * 右侧小标题显示
     */
    private void setContentCenter(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setSpacingBefore(5f);
        content.setIndentationRight(5f);
        content.setAlignment(1);
        content.setFont(font);
        document.add(content);
    }
    

    /**
     *
     * @param content 原文
     * @param oldChar 被替换的内容
     * @param newChar 需要替换的内容
     */
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) return "";
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

    /**
     * 一级内容标题
     */
    private void setContentTitle(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);;
//        try {
//            font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 12, Font.NORMAL);
//        } catch (IOException e) {
//            font = new Font(null, 12, Font.NORMAL);
//        }
        Paragraph content = new Paragraph(value);
        //行间距
        content.setSpacingBefore(15f);
        content.setFont(font);
        document.add(content);
    }

    /**
     * 一级内容标题
     */
    private void setRetractContentTitle(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);;
//        try {
//            font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 12, Font.NORMAL);
//        } catch (IOException e) {
//            font = new Font(null, 12, Font.NORMAL);
//        }
        Paragraph content = new Paragraph(value);
        //首行缩进
        content.setFirstLineIndent(8f);
        //行间距
        content.setSpacingBefore(15f);
        content.setFont(font);
        document.add(content);
    }


    public void assembleListData(JSONArray data, Document document) {
        List<Map<String, Object>> maps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<List<Map<String, Object>>>() {
        });
        if (CollUtil.isNotEmpty(maps)) {
            for (Map<String, Object> map : maps) {
                String result;
                String tag = map.get("tag").toString();
                if ("text".equals(tag)) {
                    if (Objects.isNull(map.get("content"))){
                        continue;
                    }
                    result = map.get("content").toString();
                    result = wiffOfContent(result, "<br>", "");
                    result = wiffOfContent(result, "</br>", "");
                    try {
                        setContentOne(wiffOfContent(result, "\n\n", "\n"), document);
                    } catch (DocumentException e) {
                        log.error(e.getMessage(), e);
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
                        Image image = Image.getInstance(imageBytes);
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


    public void assembleHtaListData(JSONArray data, Document document, ChannelSftp channelSftp) {
        List<Map<String, Object>> maps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<List<Map<String, Object>>>() {
        });
        if (CollUtil.isNotEmpty(maps)) {
            for (Map<String, Object> map : maps) {
                String result;
                String type = map.get("type").toString();
                if ("text".equals(type)) {
                    if (Objects.isNull(map.get("data"))) continue;
                    result = map.get("data").toString();
                    result = wiffOfContent(result, "<br>", "");
                    result = wiffOfContent(result, "</br>", "");
                    try {
                        setContentOne(wiffOfContent(result, "\n\n", "\n"), document);
                    } catch (DocumentException e) {
                        log.error(e.getMessage(), e);
                    }
                }
                if ("img".equals(type)) {
                    if (Objects.isNull(map.get("data"))) continue;
                    String url = map.get("data").toString();
                    if (StrUtil.isNotBlank(url)) {
                        int htaImageData = url.indexOf("hta_image_data");
                        url = url.substring(htaImageData);
                        url = CommonUtil.removeSeparatorFromSuffix(sftpPath).concat(Constants.PAD_LEFT_SLASH).concat(url);
                        try {
                            // 在每个线程中获取或创建一个新的InputStream
                            InputStream inputStream = channelSftp.get(url);
                            byte[] byteArray = IOUtils.toByteArray(inputStream);
                            // 读取图片文件，得到BufferedImage对象
                            Image image = Image.getInstance(byteArray);
                            // 注意注意 一定要关闭 input 流  否则 你会遇到不知道怎么解决的办法
                            inputStream.close();
                            //添加图片
                            image.setAlignment(Element.ALIGN_CENTER);
                            image.setBackgroundColor(Color.white);
                            image.scaleToFit(500, 500);
//                        image.setXYRatio(0.1f);
                            document.add(image);
                        } catch (SftpException e) {
                            log.error(e.getMessage(), e);
                            log.error("转换图片时发生错误{}",e.getMessage());
                        } catch (IOException | DocumentException e) {
                            throw new RuntimeException(e);
                        }
                    }
                }
            }
        }
    }

    /**
     * 正文参考文献
     */
    private void generateBibliography(JSONObject evidenceBasedReport, Document document) throws DocumentException {
        document.newPage();
        this.setTitleTwo("参考文献", document);
        JSONObject bibliography = evidenceBasedReport.getJSONObject("bibliography");
        if (Objects.nonNull(bibliography)) {
            JSONArray bibliographys1 = bibliography.getJSONArray("bibliographys1");
            if (CollUtil.isNotEmpty(bibliographys1)) {
                for (Object o : bibliographys1) {
                    String bibliographyStr = o.toString();
                    this.setNoRetractContentOne(bibliographyStr, document);
                }
            }
            JSONArray bibliographys2 = bibliography.getJSONArray("bibliographys2");
            if (CollUtil.isNotEmpty(bibliographys2)) {
                for (Object o : bibliographys2) {
                    String bibliographyStr = o.toString();
                    this.setNoRetractContentOne(bibliographyStr, document);
                }
            }
            JSONArray bibliographys3 = bibliography.getJSONArray("bibliographys3");
            if (CollUtil.isNotEmpty(bibliographys3)) {
                for (Object o : bibliographys3) {
                    String bibliographyStr = o.toString();
                    this.setNoRetractContentOne(bibliographyStr, document);
                }
            }
        }
    }




    //###############################   创建表格   #######################################

    /**
     * 文献数据表
     */
    private void createTableForLiteratureEnDataTable(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(8);
        table.setWidths(new float[]{5f, 8f, 5f, 8f, 8f, 10f, 8f, 8f});

        Cell[] cell_8 = new Cell[8];
        if (CollUtil.isNotEmpty(literatureDataTable)) {
            for (int i = 0; i < literatureDataTable.size(); i++) {
                Object o = literatureDataTable.get(i);
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                if (i == 0) {
                    cell_8[0] = new Cell(new Phrase("序号", fontNormal_12));
                } else {
                    cell_8[0] = new Cell(new Phrase(i + "", fontNormal_12));
                    cell_8[0].setRowspan(3);
                }
                String source = String.valueOf(jsonArray.get(0));
                source = wiffOfContent(source, "<sup>", "");
                source = wiffOfContent(source, "</sup>", "");
                cell_8[1] = new Cell(new Phrase(source, fontNormal_12));
                cell_8[2] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), fontNormal_12));
                cell_8[3] = new Cell(new Phrase(String.valueOf(jsonArray.get(2)), fontNormal_12));
                cell_8[4] = new Cell(new Phrase(String.valueOf(jsonArray.get(3)), fontNormal_12));
                cell_8[5] = new Cell(new Phrase(String.valueOf(jsonArray.get(4)), fontNormal_12));
                cell_8[6] = new Cell(new Phrase(String.valueOf(jsonArray.get(7)), fontNormal_12));
                cell_8[7] = new Cell(new Phrase(String.valueOf(jsonArray.get(8)), fontNormal_12));
                verticalAndHorizontalAlignment(cell_8, false);
                tableAddCell(table, cell_8);
                if (!"结局指标".equals(String.valueOf(jsonArray.get(5)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结局指标", fontNormal_12));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(5)), fontNormal_12));
                    cell_2[1].setColspan(6);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
                if (!"结论".equals(String.valueOf(jsonArray.get(6)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结论", fontNormal_12));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(6)), fontNormal_12));
                    cell_2[1].setColspan(6);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
            }
        }
        //将表格添加到文档中
        document.add(table);
    }
    
    private void createTableForLiteratureZhDataTable(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(7);
        table.setWidths(new float[]{5f, 8f, 5f, 8f, 8f, 10f, 8f});

        Cell[] cell_7 = new Cell[7];
        if (CollUtil.isNotEmpty(literatureDataTable)) {
            for (int i = 0; i < literatureDataTable.size(); i++) {
                Object o = literatureDataTable.get(i);
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                if (i == 0) {
                    cell_7[0] = new Cell(new Phrase("序号", fontNormal_12));
                } else {
                    cell_7[0] = new Cell(new Phrase(i + "", fontNormal_12));
                    cell_7[0].setRowspan(3);
                }
                String source = String.valueOf(jsonArray.get(0));
                source = wiffOfContent(source, "<sup>", "");
                source = wiffOfContent(source, "</sup>", "");
                cell_7[1] = new Cell(new Phrase(source, fontNormal_12));
                cell_7[2] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), fontNormal_12));
                cell_7[3] = new Cell(new Phrase(String.valueOf(jsonArray.get(2)), fontNormal_12));
                cell_7[4] = new Cell(new Phrase(String.valueOf(jsonArray.get(3)), fontNormal_12));
                cell_7[5] = new Cell(new Phrase(String.valueOf(jsonArray.get(4)), fontNormal_12));
                cell_7[6] = new Cell(new Phrase(String.valueOf(jsonArray.get(7)), fontNormal_12));
                verticalAndHorizontalAlignment(cell_7, false);
                tableAddCell(table, cell_7);
                if (!"结局指标".equals(String.valueOf(jsonArray.get(5)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结局指标", fontNormal_12));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(5)), fontNormal_12));
                    cell_2[1].setColspan(5);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
                if (!"结论".equals(String.valueOf(jsonArray.get(6)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结论", fontNormal_12));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(6)), fontNormal_12));
                    cell_2[1].setColspan(5);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
            }
        }
        //将表格添加到文档中
        document.add(table);
    }

    /**
     * 典型信号表格
     */
    private void createTableForDBAnalysis(JSONArray data, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(6);

        //第一行（表格）
        if (CollUtil.isNotEmpty(data)) {
            Cell[] cellHeaders = new Cell[6];
            cellHeaders[0] = new Cell(new Phrase("SOC分类/首选术语（PT）", fontNormal_12));
            cellHeaders[1] = new Cell(new Phrase("不良事件", fontNormal_12));
            cellHeaders[2] = new Cell(new Phrase("报告数/例", fontNormal_12));
            cellHeaders[3] = new Cell(new Phrase("ROR值", fontNormal_12));
            cellHeaders[4] = new Cell(new Phrase("EBGM值", fontNormal_12));
            cellHeaders[5] = new Cell(new Phrase("IC值", fontNormal_12));

            verticalAndHorizontalAlignment(cellHeaders, false);

            tableAddCell(table, cellHeaders);

            Cell[] cell_6 = new Cell[6];
            for (Object datum : data) {
                JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(datum), JSONObject.class);
                String soc = "";
                if (Objects.nonNull(jsonObject.get("soc"))) {
                    soc = jsonObject.get("soc").toString();
                }
                String zh = "";
                if (Objects.nonNull(jsonObject.get("zh"))) {
                    zh = jsonObject.get("zh").toString();
                }
                String en = "";
                if (Objects.nonNull(jsonObject.get("en"))) {
                    en = jsonObject.get("en").toString();
                }
                String num = "";
                if (Objects.nonNull(jsonObject.get("num"))) {
                    num = jsonObject.get("num").toString();
                }
                String ror = "";
                if (Objects.nonNull(jsonObject.get("ror"))) {
                    ror = jsonObject.get("ror").toString();
                }
                String ebgm = "";
                if (Objects.nonNull(jsonObject.get("ebgm"))) {
                    ebgm = jsonObject.get("ebgm").toString();
                }
                String ic = "";
                if (Objects.nonNull(jsonObject.get("ic"))) {
                    ic = jsonObject.get("ic").toString();
                }

                Cell[] cell_1 = new Cell[1];
                cell_1[0] = new Cell(new Phrase(soc, fontNormal_12));
                cell_1[0].setColspan(6);
                verticalAndHorizontalAlignmentCenter(cell_1, false);
                tableAddCell(table, cell_1);

                cell_6[0] = new Cell(new Phrase(en, fontNormal_12));
                cell_6[1] = new Cell(new Phrase(zh, fontNormal_12));
                cell_6[2] = new Cell(new Phrase(num, fontNormal_12));
                cell_6[3] = new Cell(new Phrase(ror, fontNormal_12));
                cell_6[4] = new Cell(new Phrase(ebgm, fontNormal_12));
                cell_6[5] = new Cell(new Phrase(ic, fontNormal_12));
                verticalAndHorizontalAlignment(cell_6, false);
                tableAddCell(table, cell_6);
            }
        }
        //将表格添加到文档中
        document.add(table);
    }

    /**
     * 不良反应表格
     */
    private void createTableForAdverseAnalysis(JSONArray adverseAnalysis, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(4);

        Cell[] cell_4 = new Cell[4];
        if (CollUtil.isNotEmpty(adverseAnalysis)) {
            cell_4[0] = new Cell(new Phrase("不良反应名称（英文）", fontNormal_12));
            cell_4[1] = new Cell(new Phrase("不良反应名称（中文）", fontNormal_12));
            cell_4[2] = new Cell(new Phrase("报告数/例", fontNormal_12));
            cell_4[3] = new Cell(new Phrase("占比", fontNormal_12));
            verticalAndHorizontalAlignment(cell_4, false);
            tableAddCell(table, cell_4);
            for (int i = 0; i < adverseAnalysis.size(); i++) {
                Object o = adverseAnalysis.get(i);
                List innerList = JSON.parseObject(JSON.toJSONString(o), new TypeReference<List>() {
                });
                cell_4[0] = new Cell(new Phrase(String.valueOf(innerList.get(1)), fontNormal_12));
                cell_4[1] = new Cell(new Phrase(String.valueOf(innerList.get(4)), fontNormal_12));
                cell_4[2] = new Cell(new Phrase(String.valueOf(innerList.get(2)), fontNormal_12));
                cell_4[3] = new Cell(new Phrase(String.valueOf(innerList.get(3)), fontNormal_12));
                verticalAndHorizontalAlignment(cell_4, false);
                tableAddCell(table, cell_4);
            }
        }
        //将表格添加到文档中
        document.add(table);
    }





    



    
    
    
    
    
    
    
    
    
    
    




















   
    
    /**
     * 三级标题
     */
    private void setTitleThree(String value, Document document) throws DocumentException {
        Font title3Font;
        try {
            title3Font = new Font(BaseFont.createFont("simsun.ttf", BaseFont.IDENTITY_H, BaseFont.NOT_EMBEDDED), 14, Font.BOLD);
        } catch (IOException e) {
            title3Font = new Font(null, 14, Font.BOLD);
        }
        Paragraph title3 = new Paragraph(value);
        // 设置标题格式对齐方式
        title3.setAlignment(Element.ALIGN_LEFT);
        title3.setFont(title3Font);
        title3.setSpacingBefore(20f);
        title3.setFirstLineIndent(10f);
        document.add(title3);
    }
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    private void paperEditAppendix(EvidenceBasedReport evidenceBasedReport, Document document) throws DocumentException {
        JSONObject paperEditJson = evidenceBasedReport.getPaperEditJson();
        int pageNum = 6;  // 限制条数
        if (Objects.nonNull(paperEditJson) 
                && (
                        CollUtil.isNotEmpty(paperEditJson.getJSONArray("rctArray")) 
                                || CollUtil.isNotEmpty(paperEditJson.getJSONArray("metaArray")) 
                                || CollUtil.isNotEmpty(paperEditJson.getJSONArray("economyArray")))) {
            this.setTitleThree("附录二：文献质量评价结果", document);
            JSONArray rctArray = paperEditJson.getJSONArray("rctArray");
            if (CollUtil.isNotEmpty(rctArray)) {
                int rctNum = 1;
                this.setTitleThree("RCT文献质量评读结果", document);
                this.setContentOne("  参考Cochrane量表，针对RCT文献进行偏倚风险评估。现将文献质量评读结果汇总如下：", document);
                int size = rctArray.size();
                int pages = size % pageNum == 0 ? size / pageNum : size / pageNum + 1;
                int begin;
                int end;
                for (int i = 0; i < pages; i++) {
                    begin = i * pageNum;
                    end = (i + 1) * pageNum;
                    if ((i + 1) * pageNum > size)  end = size;
                    List<Object> objects = rctArray.subList(begin, end);
                    JSONArray jsonArray = new JSONArray(objects);
                    this.setContentOne("附表" + rctNum++, document);
                    createTableForRctPaperEdit(jsonArray, document);
                }
            }

            JSONArray metaArray = paperEditJson.getJSONArray("metaArray");
            if (CollUtil.isNotEmpty(metaArray)) {
                int metaNum = 1;
                this.setTitleThree("系统评价/Meta文献质量评读结果", document);
                this.setContentOne("  参考AMSTAR 2量表，针对系统评价/Meta分析文献进行质量评价。现将文献质量评读结果汇总如下：", document);
                int size = metaArray.size();
                int pages = size % pageNum == 0 ? size / pageNum : size / pageNum + 1;
                int begin;
                int end;
                for (int i = 0; i < pages; i++) {
                    begin = i * pageNum;
                    end = (i + 1) * pageNum;
                    if ((i + 1) * pageNum > size)  end = size;
                    List<Object> objects = metaArray.subList(begin, end);
                    JSONArray jsonArray = new JSONArray(objects);
                    this.setContentOne("附表" + metaNum++, document);
                    createTableForMetaPaperEdit(jsonArray, document);
                }
            }
            
            JSONArray economyArray = paperEditJson.getJSONArray("economyArray");
            if (CollUtil.isNotEmpty(economyArray)) {
                int economyNum = 1;
                this.setTitleThree("经济学研究文献质量评读结果", document);
                this.setContentOne("  参考CHEERS 2022年清单，针对经济学研究文献进行质量评价。现将文献质量评读结果汇总如下：", document);
                int size = economyArray.size();
                int pages = size % pageNum == 0 ? size / pageNum : size / pageNum + 1;
                int begin;
                int end;
                for (int i = 0; i < pages; i++) {
                    begin = i * pageNum;
                    end = (i + 1) * pageNum;
                    if ((i + 1) * pageNum > size)  end = size;
                    List<Object> objects = economyArray.subList(begin, end);
                    JSONArray jsonArray = new JSONArray(objects);
                    this.setContentOne("附表" + economyNum++, document);
                    createTableForEconomyPaperEdit(jsonArray, document);
                }
            }
        }
    }

    private void createTableForRctPaperEdit(JSONArray rctArray, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();

        int size = rctArray.size();
        //创建表格
        Table table = createTableHeader(size + 1);

        Cell[] authorAndYear = new Cell[size + 1];
        Cell[] question1 = new Cell[size + 1];
        Cell[] question2 = new Cell[size + 1];
        Cell[] question3 = new Cell[size + 1];
        Cell[] question4 = new Cell[size + 1];
        Cell[] question5 = new Cell[size + 1];
        Cell[] question6 = new Cell[size + 1];
        Cell[] question7 = new Cell[size + 1];

        authorAndYear[0] = new Cell(new Phrase("类别、条目/作者（年份）", fontNormal_12));
        question1[0] = new Cell(new Phrase("选择偏倚   随机序列的产生", fontNormal_12));
        question2[0] = new Cell(new Phrase("选择偏倚   分配隐藏", fontNormal_12));
        question3[0] = new Cell(new Phrase("实施偏倚   研究者和受试者施盲", fontNormal_12));
        question4[0] = new Cell(new Phrase("测量偏倚   研究结局盲法评价", fontNormal_12));
        question5[0] = new Cell(new Phrase("随访偏倚   结果数据的完整性", fontNormal_12));
        question6[0] = new Cell(new Phrase("报告偏倚", fontNormal_12));
        question7[0] = new Cell(new Phrase("其他偏倚", fontNormal_12));

        for (int i1 = 0; i1 < rctArray.size(); i1++) {
            JSONObject metaJson = JSON.parseObject(JSON.toJSONString(rctArray.get(i1)), JSONObject.class);
            String author = metaJson.getString("author");
            String year = metaJson.getString("year");
            authorAndYear[i1+1] = new Cell(new Phrase(author + ", \n et. al.("+year+")", fontNormal_12));
            question1[i1+1] = new Cell(new Phrase(metaJson.getString("1")));
            question2[i1+1] = new Cell(new Phrase(metaJson.getString("2")));
            question3[i1+1] = new Cell(new Phrase(metaJson.getString("3")));
            question4[i1+1] = new Cell(new Phrase(metaJson.getString("4")));
            question5[i1+1] = new Cell(new Phrase(metaJson.getString("5")));
            question6[i1+1] = new Cell(new Phrase(metaJson.getString("6")));
            question7[i1+1] = new Cell(new Phrase(metaJson.getString("7")));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(authorAndYear, true);
        tableAddCell(table, authorAndYear);
        verticalAndHorizontalAlignment(question1, true);
        tableAddCell(table, question1);
        verticalAndHorizontalAlignment(question2, true);
        tableAddCell(table, question2);
        verticalAndHorizontalAlignment(question3, true);
        tableAddCell(table, question3);
        verticalAndHorizontalAlignment(question4, true);
        tableAddCell(table, question4);
        verticalAndHorizontalAlignment(question5, true);
        tableAddCell(table, question5);
        verticalAndHorizontalAlignment(question6, true);
        tableAddCell(table, question6);
        verticalAndHorizontalAlignment(question7, true);
        tableAddCell(table, question7);
        document.add(table);
    }
    
    private void createTableForMetaPaperEdit(JSONArray metaArray, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();

        int size = metaArray.size();
        //创建表格
        Table table = createTableHeader(size + 1);
        
        Cell[] authorAndYear = new Cell[size + 1];
        Cell[] question1 = new Cell[size + 1];
        Cell[] question2 = new Cell[size + 1];
        Cell[] question3 = new Cell[size + 1];
        Cell[] question4 = new Cell[size + 1];
        Cell[] question5 = new Cell[size + 1];
        Cell[] question6 = new Cell[size + 1];
        Cell[] question7 = new Cell[size + 1];
        Cell[] question8 = new Cell[size + 1];
        Cell[] question9 = new Cell[size + 1];
        Cell[] question10 = new Cell[size + 1];
        Cell[] question11 = new Cell[size + 1];
        Cell[] question12 = new Cell[size + 1];
        Cell[] question13 = new Cell[size + 1];
        Cell[] question14 = new Cell[size + 1];
        Cell[] question15 = new Cell[size + 1];
        Cell[] question16 = new Cell[size + 1];
        
        authorAndYear[0] = new Cell(new Phrase("类别、条目/作者（年份）", fontNormal_12));
        question1[0] = new Cell(new Phrase("1 PICO", fontNormal_12));
        question2[0] = new Cell(new Phrase("2 *研究方法的确定", fontNormal_12));
        question3[0] = new Cell(new Phrase("3 文献纳入类型说明", fontNormal_12));
        question4[0] = new Cell(new Phrase("4 *检索策略全面", fontNormal_12));
        question5[0] = new Cell(new Phrase("5 双人独立筛选文献", fontNormal_12));
        question6[0] = new Cell(new Phrase("6 双人独立提取数据", fontNormal_12));
        question7[0] = new Cell(new Phrase("7 *排除文献原因说明", fontNormal_12));
        question8[0] = new Cell(new Phrase("8 特征要素描述", fontNormal_12));
        question9[0] = new Cell(new Phrase("9 *偏倚评估工具", fontNormal_12));
        question10[0] = new Cell(new Phrase("10 报告研究资助来源", fontNormal_12));
        question11[0] = new Cell(new Phrase("11 *Meta分析统计方法", fontNormal_12));
        question12[0] = new Cell(new Phrase("12 偏倚风险分析", fontNormal_12));
        question13[0] = new Cell(new Phrase("13 *偏倚风险影响讨论", fontNormal_12));
        question14[0] = new Cell(new Phrase("14 异质性讨论", fontNormal_12));
        question15[0] = new Cell(new Phrase("15 *发表偏倚对定量合并影响", fontNormal_12));
        question16[0] = new Cell(new Phrase("16 利益冲突", fontNormal_12));
        
        for (int i1 = 0; i1 < metaArray.size(); i1++) {
            JSONObject metaJson = JSON.parseObject(JSON.toJSONString(metaArray.get(i1)), JSONObject.class);
            String author = metaJson.getString("author");
            String year = metaJson.getString("year");
            authorAndYear[i1+1] = new Cell(new Phrase(author + ", \n et. al.("+year+")", fontNormal_12));
            question1[i1+1] = new Cell(new Phrase(metaJson.getString("1")));
            question2[i1+1] = new Cell(new Phrase(metaJson.getString("2")));
            question3[i1+1] = new Cell(new Phrase(metaJson.getString("3")));
            question4[i1+1] = new Cell(new Phrase(metaJson.getString("4")));
            question5[i1+1] = new Cell(new Phrase(metaJson.getString("5")));
            question6[i1+1] = new Cell(new Phrase(metaJson.getString("6")));
            question7[i1+1] = new Cell(new Phrase(metaJson.getString("7")));
            question8[i1+1] = new Cell(new Phrase(metaJson.getString("8")));
            question9[i1+1] = new Cell(new Phrase(metaJson.getString("9")));
            question10[i1+1] = new Cell(new Phrase(metaJson.getString("10")));
            question11[i1+1] = new Cell(new Phrase(metaJson.getString("11")));
            question12[i1+1] = new Cell(new Phrase(metaJson.getString("12")));
            question13[i1+1] = new Cell(new Phrase(metaJson.getString("13")));
            question14[i1+1] = new Cell(new Phrase(metaJson.getString("14")));
            question15[i1+1] = new Cell(new Phrase(metaJson.getString("15")));
            question16[i1+1] = new Cell(new Phrase(metaJson.getString("16")));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(authorAndYear, true);
        tableAddCell(table, authorAndYear);
        verticalAndHorizontalAlignment(question1, true);
        tableAddCell(table, question1);
        verticalAndHorizontalAlignment(question2, true);
        tableAddCell(table, question2);
        verticalAndHorizontalAlignment(question3, true);
        tableAddCell(table, question3);
        verticalAndHorizontalAlignment(question4, true);
        tableAddCell(table, question4);
        verticalAndHorizontalAlignment(question5, true);
        tableAddCell(table, question5);
        verticalAndHorizontalAlignment(question6, true);
        tableAddCell(table, question6);
        verticalAndHorizontalAlignment(question7, true);
        tableAddCell(table, question7);
        verticalAndHorizontalAlignment(question8, true);
        tableAddCell(table, question8);
        verticalAndHorizontalAlignment(question9, true);
        tableAddCell(table, question9);
        verticalAndHorizontalAlignment(question10, true);
        tableAddCell(table, question10);
        verticalAndHorizontalAlignment(question11, true);
        tableAddCell(table, question11);
        verticalAndHorizontalAlignment(question12, true);
        tableAddCell(table, question12);
        verticalAndHorizontalAlignment(question13, true);
        tableAddCell(table, question13);
        verticalAndHorizontalAlignment(question14, true);
        tableAddCell(table, question14);
        verticalAndHorizontalAlignment(question15, true);
        tableAddCell(table, question15);
        verticalAndHorizontalAlignment(question16, true);
        tableAddCell(table, question16);
        document.add(table);
    }
    
    private void createTableForEconomyPaperEdit(JSONArray economyArray, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();

        int size = economyArray.size();
        //创建表格
        Table table = createTableHeader(size + 1);

        Cell[] authorAndYear = new Cell[size + 1];
        Cell[] question1 = new Cell[size + 1];
        Cell[] question2 = new Cell[size + 1];
        Cell[] question3 = new Cell[size + 1];
        Cell[] question4 = new Cell[size + 1];
        Cell[] question5 = new Cell[size + 1];
        Cell[] question6 = new Cell[size + 1];
        Cell[] question7 = new Cell[size + 1];
        Cell[] question8 = new Cell[size + 1];
        Cell[] question9 = new Cell[size + 1];
        Cell[] question10 = new Cell[size + 1];
        Cell[] question11 = new Cell[size + 1];
        Cell[] question12 = new Cell[size + 1];
        Cell[] question13 = new Cell[size + 1];
        Cell[] question14 = new Cell[size + 1];
        Cell[] question15 = new Cell[size + 1];
        Cell[] question16 = new Cell[size + 1];
        Cell[] question17 = new Cell[size + 1];
        Cell[] question18 = new Cell[size + 1];
        Cell[] question19 = new Cell[size + 1];
        Cell[] question20 = new Cell[size + 1];
        Cell[] question21 = new Cell[size + 1];
        Cell[] question22 = new Cell[size + 1];
        Cell[] question23 = new Cell[size + 1];
        Cell[] question24 = new Cell[size + 1];
        Cell[] question25 = new Cell[size + 1];
        Cell[] question26 = new Cell[size + 1];
        Cell[] question27 = new Cell[size + 1];
        Cell[] question28 = new Cell[size + 1];

        authorAndYear[0] = new Cell(new Phrase("类别、条目/作者（年份）", fontNormal_12));
        question1[0] = new Cell(new Phrase("1 将研究确定为经济评估，并指定要比较的干预措施", fontNormal_12));
        question2[0] = new Cell(new Phrase("2 提供结构化摘要，突出背景、关键方法、结果和相关分析", fontNormal_12));
        question3[0] = new Cell(new Phrase("3 介绍研究背景、研究问题及其与卫生政策或实践决策的相关性", fontNormal_12));
        question4[0] = new Cell(new Phrase("4 系说明是否制定了卫生经济分析计划及其获取途径。（作者应说明是否制定了数据分析（health economic analysis plan, protocol），以及读者的获取途径）", fontNormal_12));
        question5[0] = new Cell(new Phrase("5 描述研究人群特征（例如年龄范围、人口学特征、社会经济或临床特征）", fontNormal_12));
        question6[0] = new Cell(new Phrase("6 提供可能影响调查结果的相关背景信息", fontNormal_12));
        question7[0] = new Cell(new Phrase("7 描述所比较的干预措施或策略以及选择原因", fontNormal_12));
        question8[0] = new Cell(new Phrase("8 说明研究采用的角度及其选择原因", fontNormal_12));
        question9[0] = new Cell(new Phrase("9 说明研究的时间范围及其选择原因", fontNormal_12));
        question10[0] = new Cell(new Phrase("10 报告贴现率及其选择原因", fontNormal_12));
        question11[0] = new Cell(new Phrase("11 描述使用哪些结果作为获益和危害的衡量标准", fontNormal_12));
        question12[0] = new Cell(new Phrase("12 描述如何衡量/测量结果（获益和危害）", fontNormal_12));
        question13[0] = new Cell(new Phrase("13 描述用于衡量和评估结果的人群和方法", fontNormal_12));
        question14[0] = new Cell(new Phrase("14 描述如何测算成本", fontNormal_12));
        question15[0] = new Cell(new Phrase("15 报告估计资源数量和单位成本的日期，以及货币和换算年份", fontNormal_12));
        question16[0] = new Cell(new Phrase("16 如果使用模型，详细描述模型原理以及选择该模型的原因，报告模型是否公开可用以及获取途径", fontNormal_12));
        question17[0] = new Cell(new Phrase("17 描述用于分析或转换数据的方法、外推方法以及用于验证所使用模型的方法", fontNormal_12));
        question18[0] = new Cell(new Phrase("18 描述用于估计研究结果如何因亚组而异的方法", fontNormal_12));
        question19[0] = new Cell(new Phrase("19 描述对不同个体的影响，和如何调整以反映优先人群", fontNormal_12));
        question20[0] = new Cell(new Phrase("20 描述不确定性的分析方法", fontNormal_12));
        question21[0] = new Cell(new Phrase("21 描述让患者或服务接受者、公众、社区或利益相关者（如临床医生或支付方）参与研究设计的方法", fontNormal_12));
        question22[0] = new Cell(new Phrase("22 报告分析所用的参数信息（例如参数值、范围、来源），包括不确定性或参数分布假设", fontNormal_12));
        question23[0] = new Cell(new Phrase("23 报告主要类别的成本和结局指标的平均值，并以最合适的方式进行总结", fontNormal_12));
        question24[0] = new Cell(new Phrase("24 描述分析判断、输入数据或预测的不确定性如何影响结果。报告所选的贴现率和时间范围带来的影响（如果适用）", fontNormal_12));
        question25[0] = new Cell(new Phrase("25 报告患者或服务对象、公众、社区或利益相关者的参与对研究方法或研究结果造成的差异", fontNormal_12));
        question26[0] = new Cell(new Phrase("26 报告关键发现、局限性、研究未考虑的伦理或公平性，以及这些因素对患者、决策或实践的影响", fontNormal_12));
        question27[0] = new Cell(new Phrase("27 描述研究的资助方式以及资助者在分析的确定、设计、实施和报告中的作用", fontNormal_12));
        question28[0] = new Cell(new Phrase("28 根据期刊或国际医学期刊编辑委员会的要求报告作者的利益冲突", fontNormal_12));

        for (int i1 = 0; i1 < economyArray.size(); i1++) {
            JSONObject metaJson = JSON.parseObject(JSON.toJSONString(economyArray.get(i1)), JSONObject.class);
            String author = metaJson.getString("author");
            String year = metaJson.getString("year");
            authorAndYear[i1+1] = new Cell(new Phrase(author + ", \n et. al.("+year+")", fontNormal_12));
            question1[i1+1] = new Cell(new Phrase(metaJson.getString("1")));
            question2[i1+1] = new Cell(new Phrase(metaJson.getString("2")));
            question3[i1+1] = new Cell(new Phrase(metaJson.getString("3")));
            question4[i1+1] = new Cell(new Phrase(metaJson.getString("4")));
            question5[i1+1] = new Cell(new Phrase(metaJson.getString("5")));
            question6[i1+1] = new Cell(new Phrase(metaJson.getString("6")));
            question7[i1+1] = new Cell(new Phrase(metaJson.getString("7")));
            question8[i1+1] = new Cell(new Phrase(metaJson.getString("8")));
            question9[i1+1] = new Cell(new Phrase(metaJson.getString("9")));
            question10[i1+1] = new Cell(new Phrase(metaJson.getString("10")));
            question11[i1+1] = new Cell(new Phrase(metaJson.getString("11")));
            question12[i1+1] = new Cell(new Phrase(metaJson.getString("12")));
            question13[i1+1] = new Cell(new Phrase(metaJson.getString("13")));
            question14[i1+1] = new Cell(new Phrase(metaJson.getString("14")));
            question15[i1+1] = new Cell(new Phrase(metaJson.getString("15")));
            question16[i1+1] = new Cell(new Phrase(metaJson.getString("16")));
            question17[i1+1] = new Cell(new Phrase(metaJson.getString("17")));
            question18[i1+1] = new Cell(new Phrase(metaJson.getString("18")));
            question19[i1+1] = new Cell(new Phrase(metaJson.getString("19")));
            question20[i1+1] = new Cell(new Phrase(metaJson.getString("20")));
            question21[i1+1] = new Cell(new Phrase(metaJson.getString("21")));
            question22[i1+1] = new Cell(new Phrase(metaJson.getString("22")));
            question23[i1+1] = new Cell(new Phrase(metaJson.getString("23")));
            question24[i1+1] = new Cell(new Phrase(metaJson.getString("24")));
            question25[i1+1] = new Cell(new Phrase(metaJson.getString("25")));
            question26[i1+1] = new Cell(new Phrase(metaJson.getString("26")));
            question27[i1+1] = new Cell(new Phrase(metaJson.getString("27")));
            question28[i1+1] = new Cell(new Phrase(metaJson.getString("28")));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(authorAndYear, true);
        tableAddCell(table, authorAndYear);
        verticalAndHorizontalAlignment(question1, true);
        tableAddCell(table, question1);
        verticalAndHorizontalAlignment(question2, true);
        tableAddCell(table, question2);
        verticalAndHorizontalAlignment(question3, true);
        tableAddCell(table, question3);
        verticalAndHorizontalAlignment(question4, true);
        tableAddCell(table, question4);
        verticalAndHorizontalAlignment(question5, true);
        tableAddCell(table, question5);
        verticalAndHorizontalAlignment(question6, true);
        tableAddCell(table, question6);
        verticalAndHorizontalAlignment(question7, true);
        tableAddCell(table, question7);
        verticalAndHorizontalAlignment(question8, true);
        tableAddCell(table, question8);
        verticalAndHorizontalAlignment(question9, true);
        tableAddCell(table, question9);
        verticalAndHorizontalAlignment(question10, true);
        tableAddCell(table, question10);
        verticalAndHorizontalAlignment(question11, true);
        tableAddCell(table, question11);
        verticalAndHorizontalAlignment(question12, true);
        tableAddCell(table, question12);
        verticalAndHorizontalAlignment(question13, true);
        tableAddCell(table, question13);
        verticalAndHorizontalAlignment(question14, true);
        tableAddCell(table, question14);
        verticalAndHorizontalAlignment(question15, true);
        tableAddCell(table, question15);
        verticalAndHorizontalAlignment(question16, true);
        tableAddCell(table, question16);
        verticalAndHorizontalAlignment(question17, true);
        tableAddCell(table, question17);
        verticalAndHorizontalAlignment(question18, true);
        tableAddCell(table, question18);
        verticalAndHorizontalAlignment(question19, true);
        tableAddCell(table, question18);
        verticalAndHorizontalAlignment(question20, true);
        tableAddCell(table, question20);
        verticalAndHorizontalAlignment(question21, true);
        tableAddCell(table, question21);
        verticalAndHorizontalAlignment(question22, true);
        tableAddCell(table, question22);
        verticalAndHorizontalAlignment(question23, true);
        tableAddCell(table, question23);
        verticalAndHorizontalAlignment(question24, true);
        tableAddCell(table, question24);
        verticalAndHorizontalAlignment(question25, true);
        tableAddCell(table, question25);
        verticalAndHorizontalAlignment(question26, true);
        tableAddCell(table, question26);
        verticalAndHorizontalAlignment(question27, true);
        tableAddCell(table, question27);
        verticalAndHorizontalAlignment(question28, true);
        tableAddCell(table, question28);
        document.add(table);
    }
    
    
   

    /**
     * 正文参考文献
     */
    private void generateBibliographyDigest(EvidenceBasedReport evidenceBasedReport, Document document) throws DocumentException {
        document.newPage();
        this.setTitleOne("参考文献", document);
        JSONArray instructions = evidenceBasedReport.getInstructions();
        JSONArray bibliographys1 = evidenceBasedReport.getBibliography().getJSONArray("bibliographys1");
        if (CollUtil.isNotEmpty(instructions)) {
            for (Object instruction : instructions) {
                String instructionStr = (String) instruction;
                this.setContentOne(instructionStr, document);
            }
        }

        if (CollUtil.isNotEmpty(bibliographys1)) {
            for (Object bibliography : bibliographys1) {
                String bibliographyStr = (String) bibliography;
                this.setContentOne(bibliographyStr, document);
            }
        }
    }


  

    
    
    
   
    /**
     * 文献数据表
     */
    private void createTableForEconomyLiteratureDataTable(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font font1 = new Font(null, 12, Font.NORMAL);
        //创建表格
        Table table = new Table(6);
        //设置边框
        table.setBorder(1);

        if (literatureDataTable.size() == 1) {
//            this.setContentOne("暂无内容", document);
            return;
        }

        Cell[] cell_6 = new Cell[6];
        if (CollUtil.isNotEmpty(literatureDataTable)) {
            for (int i = 0; i < literatureDataTable.size(); i++) {
                Object o = literatureDataTable.get(i);
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                if (i == 0 ) {
                    cell_6[0] = new Cell(new Phrase("序号", font1));
                } else {
                    cell_6[0] = new Cell(new Phrase(i + "", font1));
                }
                String source = String.valueOf(jsonArray.get(0));
                source = wiffOfContent(source, "<sup>", "");
                source = wiffOfContent(source, "</sup>", "");
                cell_6[1] = new Cell(new Phrase(source, font1));
                cell_6[2] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), font1));
                cell_6[3] = new Cell(new Phrase(String.valueOf(jsonArray.get(2)), font1));
                cell_6[4] = new Cell(new Phrase(String.valueOf(jsonArray.get(3)), font1));
                cell_6[5] = new Cell(new Phrase(String.valueOf(jsonArray.get(4)), font1));
                verticalAndHorizontalAlignment(cell_6, false);
                tableAddCell(table, cell_6);
                if (!"结果".equals(String.valueOf(jsonArray.get(5)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结果", font1));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(5)), font1));
                    cell_2[1].setColspan(5);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
                if (!"结论".equals(String.valueOf(jsonArray.get(6)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("结论", font1));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(6)), font1));
                    cell_2[1].setColspan(5);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
            }
        }
        //将表格添加到文档中
        document.add(table);
    }


   
    /**
     * 文献检索方法
     */
    private void createTableForLiteratureMode(JSONArray table1, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(2);
        
        if (table1.size() == 1) this.setContentOne("暂无内容", document);
        
        Cell[] cell_2 = new Cell[2];
        if (table1.size() > 0) {
            for (Object o : table1) {
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                cell_2[0] = new Cell(new Phrase(String.valueOf(jsonArray.get(0)), fontNormal_12));
                cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), fontNormal_12));
                verticalAndHorizontalAlignment(cell_2, false);
                tableAddCell(table, cell_2);
            }
        }
        document.add(table);
    }
    
    /**
     * 疾病治疗药品医保收录情况分析
     */
    private void createTableForDrugList(JSONArray tableArray, String hint, Document document, String title) throws DocumentException {
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(7);
        
        if (tableArray.size() == 1) {
            if (StrUtil.isBlank(hint)) {
                if (StrUtil.isNotBlank(title)) {
                    int begin = title.indexOf("治疗");
                    int end = title.indexOf("卫生");
                    hint = "医保目录中目前尚无其他" + title.substring(begin, end) + "的药物";
                }
            }
            this.setContentOne(hint, document);
            return;
        }
        
        Cell[] cell_7 = new Cell[7];
        if (tableArray.size() > 0) {
            for (Object o : tableArray) {
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                cell_7[0] = new Cell(new Phrase(String.valueOf(jsonArray.get(0)), fontNormal_12));
                cell_7[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), fontNormal_12));
                cell_7[2] = new Cell(new Phrase(String.valueOf(jsonArray.get(2)), fontNormal_12));
                cell_7[3] = new Cell(new Phrase(String.valueOf(jsonArray.get(3)), fontNormal_12));
                cell_7[4] = new Cell(new Phrase(String.valueOf(jsonArray.get(4)), fontNormal_12));
                cell_7[5] = new Cell(new Phrase(String.valueOf(jsonArray.get(5)), fontNormal_12));
                cell_7[6] = new Cell(new Phrase(String.valueOf(jsonArray.get(6)), fontNormal_12));
                verticalAndHorizontalAlignment(cell_7, false);
                tableAddCell(table, cell_7
                );
                if (!"NMPA批准情况".equals(String.valueOf(jsonArray.get(7)))) {
                    Cell[] cell_2 = new Cell[2];
                    cell_2[0] = new Cell(new Phrase("NMPA批准情况", fontNormal_12));
                    cell_2[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(7)), fontNormal_12));
                    cell_2[1].setColspan(6);
                    verticalAndHorizontalAlignment(cell_2, false);
                    tableAddCell(table, cell_2);
                }
            }
        }
        //将表格添加到文档中
        document.add(table);
    }


    /**
     * 缩略词
     */
    private void createTableForAbbreviation(JSONArray table1, Document document) throws DocumentException {
        // 设置字体
        Font fontNormal_12 = createFontNormal_12();
        // 创建表格
        Table table = createTableHeader(3);
        
        if (table1.size() == 1) {
            this.setContentOne("暂无缩略词", document); 
            return;
        }
        
        if (table1.size() > 0){
            for (Object o : table1) {
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                if (Objects.isNull(jsonArray)) continue;
                Cell[] cell_line = new Cell[3];
                cell_line[0] = new Cell(new Phrase(String.valueOf(jsonArray.get(0)), fontNormal_12));
                cell_line[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), fontNormal_12));
                cell_line[2] = new Cell(new Phrase(String.valueOf(jsonArray.get(2)), fontNormal_12));
                cell_line[0].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell_line[0].setHorizontalAlignment(Element.ALIGN_CENTER);
                cell_line[1].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell_line[1].setHorizontalAlignment(Element.ALIGN_CENTER);
                cell_line[2].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell_line[2].setHorizontalAlignment(Element.ALIGN_CENTER);
                table.addCell(cell_line[0]);
                table.addCell(cell_line[1]);
                table.addCell(cell_line[2]);
            }
            document.add(table);
        }
    }
    
    /**
     * 国内外主要HTA组织评估报告
     */
    private void createTableForHTAReport(JSONArray table1, Document document) throws DocumentException {
        // 设置字体
        Font font1 = new Font(null, 12, Font.NORMAL);
        // 设置表格列数
        Table table = new Table(2);
        // 设置表格边框
        table.setBorder(1);
        // 设置表格与上方内容的间距
        table.setOffset(-20f);

        int size = table1.size();
        if (size == 1) this.setContentOne("暂无内容", document);
        
        if (table1.size() >0){
            for (Object o : table1) {
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                if (Objects.isNull(jsonArray)) continue;
                Cell[] cell_line = new Cell[2];
                cell_line[0] = new Cell(new Phrase(String.valueOf(jsonArray.get(0)), font1));
                cell_line[1] = new Cell(new Phrase(String.valueOf(jsonArray.get(1)), font1));
                cell_line[0].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell_line[0].setHorizontalAlignment(Element.ALIGN_CENTER);
                cell_line[1].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell_line[1].setHorizontalAlignment(Element.ALIGN_CENTER);
                table.addCell(cell_line[0]);
                table.addCell(cell_line[1]);
            }
            document.add(table);
        }
    }

    private void createTableForDrugComparison(JSONArray drugCompares, Document document) throws DocumentException {
        int size = drugCompares.size();
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(size + 1);

        List<String> list_1 = new ArrayList<>();
        list_1.add("维度");
        List<String> list_2 = new ArrayList<>(); 
        list_2.add("上市时间");
        List<String> list_3 = new ArrayList<>();
        list_3.add("获批适应症");
        List<String> list_4 = new ArrayList<>();
        list_4.add("给药方式");
        List<String> list_5 = new ArrayList<>();
        list_5.add("作用机制");
        List<String> list_7 = new ArrayList<>();
        list_7.add("特殊人群使用");
        List<String> list_8 = new ArrayList<>();
        list_8.add("疗效");
        List<String> list_9 = new ArrayList<>();
        list_9.add("安全性");
        List<String> list_10 = new ArrayList<>();
        list_10.add("创新性");

        for (int i = 0; i < drugCompares.size(); i++) {
            JSONObject drugInfo = JSON.parseObject(JSON.toJSONString(drugCompares.get(i)), JSONObject.class);
            list_1.add(drugInfo.getString("name"));
            list_2.add(drugInfo.getString("time"));
            list_3.add(drugInfo.getString("indications"));
            list_4.add(drugInfo.getString("pattern"));
            list_5.add(drugInfo.getString("mechanics"));
            list_7.add(drugInfo.getString("special"));
            list_8.add(drugInfo.getString("effective"));
            list_9.add(drugInfo.getString("safety"));
            list_10.add(drugInfo.getString("innovation"));
        }

        Cell[] cell_line1 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line1[i] = new Cell(new Phrase(list_1.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line1, false);
        // 加入table
        tableAddCell(table, cell_line1);

        Cell[] cell_line2 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line2[i] = new Cell(new Phrase(list_2.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line2, false);
        // 加入table
        tableAddCell(table, cell_line2);

        Cell[] cell_line3 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line3[i] = new Cell(new Phrase(list_3.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line3, false);
        // 加入table
        tableAddCell(table, cell_line3);

        Cell[] cell_line4 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line4[i] = new Cell(new Phrase(list_4.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line4, false);
        // 加入table
        tableAddCell(table, cell_line4);

        Cell[] cell_line5 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line5[i] = new Cell(new Phrase(list_5.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line5, false);
        // 加入table
        tableAddCell(table, cell_line5);

//        Cell[] cell_line6 = new Cell[size + 1];
//        for (int i = 0; i < size + 1; i++) {
//            cell_line6[i] = new Cell(new Phrase(list_6.get(i), fontNormal_12));
//        }
//        // 横向与纵向剧中
//        verticalAndHorizontalAlignment(cell_line6, false);
//        // 加入table
//        tableAddCell(table, cell_line6);

        Cell[] cell_line7 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line7[i] = new Cell(new Phrase(list_7.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line7, false);
        // 加入table
        tableAddCell(table, cell_line7);

        Cell[] cell_line8 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line8[i] = new Cell(new Phrase(list_8.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line8, false);
        // 加入table
        tableAddCell(table, cell_line8);

        Cell[] cell_line9 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line9[i] = new Cell(new Phrase(list_9.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line9, false);
        // 加入table
        tableAddCell(table, cell_line9);

        Cell[] cell_line10 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line10[i] = new Cell(new Phrase(list_10.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line10, false);
        // 加入table
        tableAddCell(table, cell_line10);

        document.add(table);
    }


    /**
     * 建议对照品
     */
    private void createTableForDrugCompares(JSONArray drugCompares, Document document) throws DocumentException {
        int size = drugCompares.size();
        //设置字体
        Font fontNormal_12 = createFontNormal_12();
        //创建表格
        Table table = createTableHeader(size + 1);

        List<String> list_1 = new ArrayList<>(Collections.singletonList(" ")); // 第一行
        List<String> list_2 = new ArrayList<>(); // 通用名
        list_2.add("通用名");
        List<String> list_3 = new ArrayList<>();
        list_3.add("商品名");
        List<String> list_4 = new ArrayList<>();
        list_4.add("主成份/含量");
        List<String> list_5 = new ArrayList<>();
        list_5.add("剂型/包装");
        List<String> list_6 = new ArrayList<>();
        list_6.add("药监局许可适应症");
        List<String> list_7 = new ArrayList<>();
        list_7.add("说明书建议剂量与用法");
        List<String> list_8 = new ArrayList<>();
        list_8.add("疗程");
        List<String> list_9 = new ArrayList<>();
        list_9.add("有无直接比较试验（head-head comparison）");
        List<String> list_10 = new ArrayList<>();
        list_10.add("有无间接比较试验（indirect comparison）");
        List<String> list_11 = new ArrayList<>();
        list_11.add("其他选择该对照品的考虑因素，请说明：(若无对照品，表格中无需显示此整行）");
        
        int notEvaluation = 1;
        for (int i = 0; i < drugCompares.size(); i++) {
            JSONObject drugInfo = JSON.parseObject(JSON.toJSONString(drugCompares.get(i)), JSONObject.class);
            if (drugInfo.getBoolean("isI")) {
                list_1.add("本次评估药品");
            } else {
                list_1.add("对照药" + (notEvaluation++));
            }
            list_2.add(drugInfo.getString("drugName"));
            list_3.add(drugInfo.getString("commodityName"));
            list_4.add(drugInfo.getString("ingredient") + "/" + drugInfo.getString("specifications"));
            list_5.add(drugInfo.getString("dosageForm") + "/" + drugInfo.getString("package"));
            list_6.add(drugInfo.getString("indications"));
            list_7.add(drugInfo.getString("usageAndDosage"));
            list_8.add(drugInfo.getString("treatment"));
            list_9.add(drugInfo.getString("headHeadComparison"));
            list_10.add(drugInfo.getString("indirectComparison"));
            list_11.add(drugInfo.getString("otherFactor"));
        }
        
        Cell[] cell_line1 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line1[i] = new Cell(new Phrase(list_1.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line1, false);
        // 加入table
        tableAddCell(table, cell_line1);

        Cell[] cell_line2 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line2[i] = new Cell(new Phrase(list_2.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line2, false);
        // 加入table
        tableAddCell(table, cell_line2);

        Cell[] cell_line3 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line3[i] = new Cell(new Phrase(list_3.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line3, false);
        // 加入table
        tableAddCell(table, cell_line3);

        Cell[] cell_line4 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line4[i] = new Cell(new Phrase(list_4.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line4, false);
        // 加入table
        tableAddCell(table, cell_line4);

        Cell[] cell_line5 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line5[i] = new Cell(new Phrase(list_5.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line5, false);
        // 加入table
        tableAddCell(table, cell_line5);

        Cell[] cell_line6 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line6[i] = new Cell(new Phrase(list_6.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line6, false);
        // 加入table
        tableAddCell(table, cell_line6);

        Cell[] cell_line7 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line7[i] = new Cell(new Phrase(list_7.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line7, false);
        // 加入table
        tableAddCell(table, cell_line7);

        Cell[] cell_line8 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line8[i] = new Cell(new Phrase(list_8.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line8, false);
        // 加入table
        tableAddCell(table, cell_line8);

        Cell[] cell_line9 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line9[i] = new Cell(new Phrase(list_9.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line9, false);
        // 加入table
        tableAddCell(table, cell_line9);

        Cell[] cell_line10 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line10[i] = new Cell(new Phrase(list_10.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line10, false);
        // 加入table
        tableAddCell(table, cell_line10);

        Cell[] cell_line11 = new Cell[size + 1];
        for (int i = 0; i < size + 1; i++) {
            cell_line11[i] = new Cell(new Phrase(list_11.get(i), fontNormal_12));
        }
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line11, false);
        // 加入table
        tableAddCell(table, cell_line11);
        
        document.add(table);
    }
    
    private Table createTableHeader(int columes) throws BadElementException {
        //创建表格
        Table table = new Table(columes);
        //设置边框
        table.setBorder(1);
        table.setWidth(100f);
        return table;
    }
    private Font createFontNormal_12() {
        return new Font(null, 12, Font.NORMAL);
    }

    /**
     * 药品信息表格
     */
    public void createTableForDrugInfos(Map<String, String> map, Document document) throws DocumentException {
        // 字体
        Font font_12 = createFontNormal_12();
        // 表格
        Table table = createTableHeader(4);
        // 数据
        Cell[] cell_line1 = new Cell[4];
        cell_line1[0] = new Cell(new Phrase("药品通用名称", font_12));
        cell_line1[1] = new Cell(new Phrase(map.get("drugName"), font_12));
        cell_line1[2] = new Cell(new Phrase("成分", font_12));
        cell_line1[3] = new Cell(new Phrase(map.get("ingredient"), font_12));
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line1, false);
        // 加入table
        tableAddCell(table, cell_line1);
        
        Cell[] cell_line2 = new Cell[4];
        cell_line2[0] = new Cell(new Phrase("药品商品名称", font_12));
        cell_line2[1] = new Cell(new Phrase(map.get("communityName"), font_12));
        cell_line2[2] = new Cell(new Phrase("剂型", font_12));
        cell_line2[3] = new Cell(new Phrase(map.get("dosageForm"), font_12));
        // 横向与纵向剧中
        verticalAndHorizontalAlignment(cell_line2, false);
        // 加入table
        tableAddCell(table, cell_line2);
        
        
        Cell cell_3_1 = new Cell(new Phrase("药监局许可适应症", font_12));
        cell_3_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_3_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_3_1);
        Cell cell_3_2 = new Cell(new Phrase(map.get("indications"), font_12));
        cell_3_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_3_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_3_2.setColspan(3);
        table.addCell(cell_3_2);

        Cell cell_4_1 = new Cell(new Phrase("用法用量", font_12));
        cell_4_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_4_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_4_1);
        // 合并单元格
        Cell cell_4_2 = new Cell(new Phrase(map.get("usageAndDosage"), font_12));
        cell_4_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_4_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_4_2.setColspan(3);
        table.addCell(cell_4_2);

        Cell cell_5_1 = new Cell(new Phrase("建议疗程与期限", font_12));
        cell_5_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_5_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_5_1);
        // 合并单元格
        Cell cell_5_2 = new Cell(new Phrase(map.get("suggestCourseAndDuration"), font_12));
        cell_5_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_5_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_5_2.setColspan(3);
        table.addCell(cell_5_2);

        Cell cell_6_1 = new Cell(new Phrase("创新药特征", font_12));
        cell_6_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_6_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_6_1);
        // 合并单元格
        Cell cell_6_2 = new Cell(new Phrase(map.get("innovativeDrugFet"), font_12));
        cell_6_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_6_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_6_2.setColspan(3);
        table.addCell(cell_6_2);

        Cell cell_7_1 = new Cell(new Phrase("医保是否还有支付其他含同成份（复方）药品", font_12));
        cell_7_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_7_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_7_1);
        // 合并单元格
        Cell cell_7_2 = new Cell(new Phrase(map.get("otherCompoundDrug"), font_12));
        cell_7_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_7_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_7_2.setColspan(3);
        table.addCell(cell_7_2);

        Cell cell_8_1 = new Cell(new Phrase("产品图片", font_12));
        cell_8_1.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_8_1.setHorizontalAlignment(Element.ALIGN_CENTER);
        table.addCell(cell_8_1);
        // 合并单元格
        Cell cell_8_2 = new Cell(new Phrase(map.get("productPic"), font_12));
        cell_8_2.setVerticalAlignment(Element.ALIGN_MIDDLE);
        cell_8_2.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell_8_2.setColspan(3);
        table.addCell(cell_8_2);
        
        document.add(table);
    }

    private void tableAddCell(Table table, Cell[] cell) {
        if (Objects.nonNull(cell) && cell.length > 0) {
            for (Cell cell1 : cell) {
                table.addCell(cell1);
            }
        }
    }

    private void verticalAndHorizontalAlignment(Cell[] cell, boolean firstCellLeft) {
        if (Objects.nonNull(cell) && cell.length > 0) {
            for (int i = 0; i < cell.length; i++) {
                if (firstCellLeft && i == 0) continue;
                cell[i].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell[i].setHorizontalAlignment(Element.ALIGN_CENTER);
            }
        }
    }

    private void verticalAndHorizontalAlignmentCenter(Cell[] cell, boolean firstCellLeft) {
        if (Objects.nonNull(cell) && cell.length > 0) {
            for (int i = 0; i < cell.length; i++) {
                if (firstCellLeft && i == 0) continue;
                cell[i].setVerticalAlignment(Element.ALIGN_LEFT);
                cell[i].setHorizontalAlignment(Element.ALIGN_LEFT);
            }
        }
    }


    /**
     * 一级标题居中
     */
    private void setTitleOneCenter(String value, float spacingBefore, Document document) throws DocumentException {
        Font title1Font = new Font(null, 18, Font.BOLD);
        Paragraph title0 = new Paragraph(value);
        title0.setAlignment(Element.ALIGN_CENTER);
        //设置段前段后间距
        title0.setSpacingBefore(spacingBefore);
        title0.setFont(title1Font);
        document.add(title0);
    }
    
    /**
     * 二级标题居中
     */
    private void setTitleTwoCenter(String value, float spacingBefore, float spacingAfter, Document document) throws DocumentException {
        Font title1Font = new Font(null, 16, Font.BOLD);
        Paragraph title0 = new Paragraph(value);
        title0.setAlignment(Element.ALIGN_CENTER);
        //设置段前段后间距
        title0.setSpacingBefore(spacingBefore);
        title0.setSpacingAfter(spacingAfter);
        title0.setFont(title1Font);
        document.add(title0);
    }
    
    

    

    /**
     * 表格上方内容
     */
    private void setContentTableCenter(String value, Document document) throws DocumentException {
        Font tableTitleFont = new Font(null, 8, Font.NORMAL);
        Paragraph tableTitle = new Paragraph(value);
        // 设置标题格式对齐方式
        tableTitle.setAlignment(Element.ALIGN_CENTER);
        tableTitle.setSpacingBefore(15f);
        tableTitle.setSpacingAfter(0f);
        tableTitle.setFont(tableTitleFont);
        document.add(tableTitle);
    }

    /**
     * 表格上方内容
     */
    private void setTitleTableCenter(String value, Document document) throws DocumentException {
        Font titleTableFont = new Font(null, 14, Font.NORMAL);
        Paragraph tableTitle = new Paragraph(value);
        // 设置标题格式对齐方式
        tableTitle.setAlignment(Element.ALIGN_CENTER);
        tableTitle.setSpacingBefore(20f);
        tableTitle.setFont(titleTableFont);
        document.add(tableTitle);
    }
    

    

    
    
    private void addBlank(Document document, int n) throws DocumentException {
        Paragraph blankSpace = new Paragraph("");
        Font blankSize = new Font(null, 12, Font.NORMAL);
        blankSpace.setFont(blankSize);
        for (int i = 0; i < n; i++) {
            document.add(blankSpace);
        }
    }

    private void setPageNum(Document document) {
        Font font = new Font();
        Paragraph paraFooter = new Paragraph();
        //页脚的字体大小
        font.setSize(12f);
        font.setColor(new Color(0, 0, 0));
        paraFooter.add(new RtfPageNumber());
        paraFooter.add(" / ");
        paraFooter.add(new RtfTotalPageNumber());
        paraFooter.setFont(font);
        RtfHeaderFooter footer = new RtfHeaderFooter(paraFooter);
        //页脚的对齐方式（应该在footer设置而不是段落中设置）
        footer.setAlignment(1);
        document.setFooter(footer);
    }

    private void appendixList(EvidenceBasedReport evidenceBasedReport, Document document) throws DocumentException {
        log.info("生成附录开始");
        document.newPage();
        this.setTitleOne("附录一：\"推荐等级\"评价标准", document);

//        this.setTitleOneTwo("附录一、“推荐等级”评价标准", document);
        addBlank(document, 1);
        Image image1 = this.readImage("/image/recommendCriteria.jpg", "recommendCriteria");
        image1.setAlignment(Element.ALIGN_LEFT);
        //依照比例缩放
        image1.scalePercent(71f);
        // 设置图片的显示大小
        //image1.scaleToFit(700, 871);
        image1.setSpacingBefore(20f);
        document.add(image1);
        document.newPage();

//        this.setTitleOneTwo("附录二、“安全性”评价标准", document);
//        addBlank(document, 1);
//        Image image2 = this.readImage("/image/safetyCriteria.jpg", "safetyCriteria");
//        image2.setAlignment(Element.ALIGN_LEFT);
//        image2.scalePercent(51f);
//        // 设置图片的显示大小
//        //image2.scaleToFit(711, 478);
//        image2.setSpacingBefore(20f);
//        document.add(image2);
    }

    /**
     * 生成图片
     * @param path 图片路径
     * @param name 图片名称
     */
    private Image readImage(String path, String name) {
        Image image = null;
        try {
            //添加图片
            ClassPathResource classPathResource = new ClassPathResource(path);
            InputStream inputStreamImg = classPathResource.getInputStream();
            BufferedImage read = ImageIO.read(inputStreamImg);
            //通过将文件转换为临时文件进行操作
            File imgFile = File.createTempFile(name, ".jpg");
            ImageIO.write(read, "jpg", imgFile);
            image = Image.getInstance(String.valueOf(imgFile));
        } catch (Exception e) {
            log.error("读取图片文件出现异常，{}", ExceptionUtils.getFullStackTrace(e));
        }
        return image;
    }

    
    /**
     * 生成图片
     * @param in 流
     * @param name 图片名称
     */
    private Image readImageForInputStream(InputStream in, String name) {
        Image image = null;
        try {
            //添加图片
            BufferedImage read = ImageIO.read(in);
            //通过将文件转换为临时文件进行操作
            File imgFile = File.createTempFile(name, ".jpg");
            ImageIO.write(read, "jpg", imgFile);
            image = Image.getInstance(String.valueOf(imgFile));
        } catch (Exception e) {
            log.error("读取图片文件出现异常，{}", ExceptionUtils.getFullStackTrace(e));
        }
        return image;
    }
    
}
