package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.auth0.jwt.interfaces.Claim;
import com.lowagie.text.Font;
import com.lowagie.text.Image;
import com.lowagie.text.*;
import com.lowagie.text.rtf.RtfWriter2;
import com.lowagie.text.rtf.field.RtfPageNumber;
import com.lowagie.text.rtf.field.RtfTotalPageNumber;
import com.lowagie.text.rtf.headerfooter.RtfHeaderFooter;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.constants.PriorityConstants;
import com.sentum.evidencecomprehensive.constants.PromptConstant;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.infrastructure.kafka.KafkaSender;
import com.sentum.evidencecomprehensive.pojo.bo.es.GuideBlockIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.GuideIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.InstructionIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.PaperIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.PaperIncludeOrExclude;
import com.sentum.evidencecomprehensive.pojo.dto.DrugDto;
import com.sentum.evidencecomprehensive.pojo.dto.entity.PdfEditResult;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.pojo.vo.*;
import com.sentum.evidencecomprehensive.service.*;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.JwtUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.collections.MapUtils;
import org.apache.commons.lang.exception.ExceptionUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.metrics.ParsedSum;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@Service
@Slf4j
public class SuperManualReportServiceImpl implements SuperManualReportService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private AdverseService adverseService;
    @Autowired
    private PaperService paperService;
    @Autowired
    private GuideService guideService;
    @Autowired
    private QuestionService questionService;
    @Autowired
    private KafkaSender kafkaSender;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private JwtUtils jwtUtils;
    @Autowired
    private RetrievalService retrievalService;
    @Autowired
    private PdfEditResultService pdfEditResultService;
    @Autowired
    private RetryUtils retryUtils;
    @Autowired
    @Qualifier("reportExecutor")
    private Executor reportExecutor;
    
    @Value("${download.url}")
    private String downloadUrl;
    @Value("${local.excel.path}")
    private String localExcelPath;

    @Override
    public JSONObject createPc(String id, Long userId, String type, String source, String verifyToken, HttpServletRequest request){
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }

        Date startDate = new Date();

        // 前端使用的数据
        JSONObject data = new JSONObject();
        JSONObject result = new JSONObject();

        //判断是否是默认生成报告
        JSONObject report = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
        if (report == null) {
            questionService.create(id, userId, request);
        } else {
            // 保证 只要点击生成报告 就是重新生成
            String token = verifyTokenValid(verifyToken);
            if (StringUtils.isNotBlank(token)) {
                //保存课题历史
                questionService.insertHistory(id);
            } else {
                return report;
            }
        }

        LiteratureGuideVo literatureGuide = mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), LiteratureGuideVo.class, "evaluation_literatureGuideConfirm");
        if ("2".equals(type) && Objects.isNull(literatureGuide)) {
            retrievalService.acquireLiteratureGuide(id, userId);
//            include(id, userId, data);
        }

        data.put("reportVersion", 1.0);
        RedisUtils.set("superReportVersion", 1.0);

        result.put("data", data);
        //开始创建报告
        long startTime = System.currentTimeMillis();
        //id
        result.put("_id", id);
        data.put("_id", id);
        //标题
        result.put("title", getInfo(condition) + "的药学循证查证");
        data.put("title", getInfo(condition) + "的药学循证查证");

        // 处理初始数据
        handleInitialData(condition, result);

        result.put("referenceCount", 0);
        JSONArray bibliographys = new JSONArray();
        result.put("bibliographys", bibliographys);

        // 模块间的并发
        Date concurrenceData = new Date();

        CompletableFuture<Void> oneFuture = CompletableFuture.runAsync(() -> {
            int referenceCount = result.getInteger("referenceCount");
            referenceCount++;
            // yi、国内外说明书
            Date zeroDate = new Date();
            indication(condition, result, data, referenceCount);
            log.info("一 模块（说明书）完成，花费时间{}", new Date().getTime() - zeroDate.getTime());

            referenceCount = result.getInteger("referenceCount");
            if (referenceCount == 0) referenceCount++;
            // er、指南文献
            Date oneDate = new Date();
            effective(condition, result, data, userId, referenceCount);
            log.info("二 模块（指南文献）完成，花费时间{}", new Date().getTime() - oneDate.getTime());
        }, reportExecutor);

        CompletableFuture<Void> threeFuture = CompletableFuture.runAsync(() -> {
            //san、安全性查询结果
            Date threeDate = new Date();
            safety(condition, result, data);
            log.info("三 模块（安全性相关）完成，花费时间{}", new Date().getTime() - threeDate.getTime());
        }, reportExecutor);

//        CompletableFuture<Void> allFuture = CompletableFuture.allOf(threeFuture);
        CompletableFuture<Void> allFuture = CompletableFuture.allOf(oneFuture, threeFuture);
//        CompletableFuture<Void> allFuture = CompletableFuture.allOf(oneFuture, twoFuture, threeFuture);
        allFuture.join();
        log.info("报告所有模块完成，花费时间{}", new Date().getTime() - concurrenceData.getTime());

        // 五、分析结论
        conclusion(result, data);

        //六、参考文献：
        JSONArray instructions = result.getJSONArray("instructions");
        if (CollectionUtils.isNotEmpty(instructions)) {
            bibliographys.addAll(instructions);
        }

        JSONArray duplicateGuide = result.getJSONArray("duplicateGuide");
        if (CollectionUtils.isNotEmpty(duplicateGuide)) {
            bibliographys.addAll(duplicateGuide);
        }
        JSONArray references = result.getJSONArray("references");
        if (CollectionUtils.isNotEmpty(references)) {
            bibliographys.addAll(references);
        }
        data.put("bibliographys", bibliographys);

        log.info("[{}]---报告生成完成，用时[{}]秒。", id, (System.currentTimeMillis() - startTime) / 1000);
        mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), "super_manual_Report");
        mongoTemplate.insert(data, "super_manual_Report");

        tokenInvalid(verifyToken);

        //发送kafka生成报告进行微信展示
        log.info("开始发送kafka创建文件--{}", id);
        JSONObject dataJson = new JSONObject();
        dataJson.put("id", id);
        dataJson.put("userId", userId);
        dataJson.put("token", request.getHeader("token"));
        dataJson.put("type", "超说明书用药循证报告");
        dataJson.put("name", result.getString("title") + ".doc");
        dataJson.put("url", downloadUrl + "?id="+id + "&source="+source);
        Date endDate = new Date();
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        dataJson.put("startTime", format.format(startDate));
        dataJson.put("endTime", format.format(endDate));
        kafkaSender.sendReportInfo(dataJson);

        return data;
    }

    @Override
    public void include(String id, long userId, JSONObject data) {
        if (StringUtils.isNotBlank(id)) {
            Condition condition = mongoTemplate.findById(id, Condition.class);
            if (Objects.nonNull(condition)) {
                try {
                    DateTime dateTime = new DateTime();
                    ExecutorService executorService = Executors.newFixedThreadPool(2);

                    CompletableFuture<Void> paperFuture = CompletableFuture.runAsync(() -> {
                        DateTime dateTime1 = new DateTime();
                        paperService.includeLatest(id, userId);
                        log.info("文献默认纳入花费时间{}", DateTime.now().getTime() - dateTime1.getTime());
                    }, executorService);

                    CompletableFuture<Void> guideFuture = CompletableFuture.runAsync(() -> {
                        DateTime dateTime2 = new DateTime();
                        guideService.includeLatest(id, userId);
                        log.info("指南默认纳入花费时间{}", DateTime.now().getTime() - dateTime2.getTime());
                    }, executorService);

                    CompletableFuture<Void> allFuture = CompletableFuture.allOf(paperFuture, guideFuture);

                    allFuture.join();

                    executorService.shutdown();

                    try {
                        if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                            executorService.shutdownNow();
                        }
                    } catch (InterruptedException e) {
                        executorService.shutdownNow();
                        Thread.currentThread().interrupt();
                    }
                    
                    condition.setInclusionSuccess(true);
                    log.info("默认纳入完成，花费时间{}", DateTime.now().getTime() - dateTime.getTime());
                } catch (Exception e) {
                    condition.setInclusionSuccess(false);
                    log.error("默认纳入有错误！---{}", e.getMessage(), e);
                }
                mongoTemplate.save(condition);
            }
        }
    }
    @Override
    public void downloadPc(String id, String source, HttpServletResponse response, String channel) {
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        JSONObject superManualReport = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
        if (Objects.nonNull(superManualReport)) {

            String title = superManualReport.getString("title");
            title = title.replaceAll("/", "-");

            String filePath =  CommonUtil.removeSeparatorFromSuffix(localExcelPath).concat(File.separator).concat( title + ".doc");
            response.setHeader("Content-Disposition", "attachment;fileName=" + title + ".doc");
            try {
                Document document = new Document(PageSize.A4);
                document.setMargins(50, 50, 50, 50);
                RtfWriter2 rtfWriter;
                if ("excel".equals(channel)) {
                    FileOutputStream fileOutputStream = new FileOutputStream(filePath);
                    rtfWriter = RtfWriter2.getInstance(document, fileOutputStream);
                } else {
                    ServletOutputStream outputStream = response.getOutputStream();
                    rtfWriter = RtfWriter2.getInstance(document, outputStream);
                }
//                rtfWriter.setAutogenerateTOCEntries(true);

                // 加载 Logo 图片
                Image logo = this.readImage("/image/lingxi.jpg", "lingxi");
                // 设置 Logo 大小
                logo.scalePercent(10.0f, 10.0f);
                logo.setBackgroundColor(Color.red);
                // 创建 HeaderFooter 实例
                Paragraph paragraph = new Paragraph();
                paragraph.add(logo);
                HeaderFooter headerFooter = new HeaderFooter(paragraph, false);
                headerFooter.setAlignment(2);
                // 将 HeaderFooter 实例设置到 PdfWriter
                rtfWriter.setHeader(headerFooter);

                document.open();

                this.addBlank(document, 7);
                //设置标题及上下线
                Paragraph paragraph1 = new Paragraph(title);
                Font blankSize = new Font(null, 24, Font.BOLD);
                paragraph1.setFont(blankSize);
                paragraph1.setAlignment(1);
                document.add(paragraph1);

                if ("app".equals(source)) {
                    this.addBlank(document, 16);
                    this.setCenterContent("灵犀量子（北京）医疗科技有限公司", document);
                    LocalDate now = LocalDate.now();
                    DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                    String format = formatter.format(now);
                    this.setCenterContent(format, document);
                } else {
                    this.addBlank(document, 26);
                    this.setCenterContent("灵犀量子（北京）医疗科技有限公司", document);
                    LocalDate now = LocalDate.now();
                    DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                    String format = formatter.format(now);
                    this.setCenterContent(format, document);
                }
                this.addBlank(document, 1);
                this.setContentAi("本报告包含由EviMed模型AI生成的内容与人工编辑确认内容", document);

                document.newPage();
                // 结论
                String conclusion = superManualReport.getString("conclusion");
                if (StringUtils.isNotBlank(conclusion)) {
                    setNoFirstLineContent(conclusion, document);
                } else {
                    setNoFirstLineContent("暂无内容", document);
                }

                //一、国内外说明书查询
                setTitle("一、国内外说明书查询", document);
                setTitle("1. NMPA说明书", document);
                String indication = superManualReport.getString("indication");
                if (StringUtils.isNotBlank(indication)) {
                    indication = indication.replaceAll("</sup>", "").replaceAll("<sup>", "");
                    setNoFirstLineContent(indication, document);
                } else {
                    setNoFirstLineContent("暂无内容", document);
                }

                // 国外说明书
                setTitle("2. 国外说明书", document);
                String indicationFda = superManualReport.getString("indicationFda");
                indicationFda = indicationFda.replaceAll("</sup>", "").replaceAll("<sup>", "");
                setNoFirstLineContent("（1）" + indicationFda, document);
                String indicationEma = superManualReport.getString("indicationEma");
                indicationEma = indicationEma.replaceAll("</sup>", "").replaceAll("<sup>", "");
                setNoFirstLineContent("（2）" + indicationEma, document);
                String indicationPmda = superManualReport.getString("indicationPmda");
                indicationPmda = indicationPmda.replaceAll("</sup>", "").replaceAll("<sup>", "");
                setNoFirstLineContent("（3）" + indicationPmda, document);

                setTitle("二、指南/共识", document);
                JSONArray guide = superManualReport.getJSONArray("guide");
                if (CollectionUtils.isNotEmpty(guide)) {
                    for (Object o : guide) {
                        JSONObject obj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                        String guideTitle = obj.getString("title");
                        guideTitle = wiffOfContent(guideTitle, "<sup>", "");
                        guideTitle = wiffOfContent(guideTitle, "</sup>", "");
                        String guideData = obj.getString("data");
                        setNoFirstLineContent(guideTitle, document);
                        setNoFirstLineContent(guideData, document);
                    }
                } else {
                    setContent("暂无相关指南.", document);
                }
                
                setTitle("三、有效性查询结果", document);
//                int literatureCount = 1;
//                JSONObject literature = superManualReport.getJSONObject("literature");
//                JSONArray metaLiteratureDataTable = literature.getJSONArray("metaLiteratureDataTable");
//                JSONArray testLiteratureDataTable = literature.getJSONArray("testLiteratureDataTable");
//                JSONArray otherLiteratureDataTable = literature.getJSONArray("otherLiteratureDataTable");
//                if (CollectionUtils.isNotEmpty(metaLiteratureDataTable)) {
//                    setTitle("【3."+ literatureCount++ +"】 系统综述/Meta分析", document);
//                    createTableForLiterature(metaLiteratureDataTable, document);
//                }
//
//                if (CollectionUtils.isNotEmpty(testLiteratureDataTable)) {
//                    setTitle("【3."+ literatureCount++ +"】 随机对照试验（RCT）和临床试验", document);
//                    createTableForLiterature(testLiteratureDataTable, document);
//                }
//                if (CollectionUtils.isNotEmpty(otherLiteratureDataTable)) {
//                    setTitle("【3."+ literatureCount +"】 其他", document);
//                    createTableForOtherLiterature(otherLiteratureDataTable, document);
//                }
//                if (CollUtil.isEmpty(metaLiteratureDataTable) && CollUtil.isEmpty(testLiteratureDataTable) && CollUtil.isEmpty(otherLiteratureDataTable)) {
//                    setContent("暂无内容", document);
//                }
                JSONObject paperEffectSummary = superManualReport.getJSONObject("paperEffectSummary");
                if (Objects.nonNull(paperEffectSummary)) {
                    String summaryTitle = paperEffectSummary.getString("summaryTitle");
                    if (StringUtils.isNotBlank(summaryTitle)) {
                        summaryTitle = summaryTitle.replaceAll("<b>", "").replaceAll("</b>", "");
                        setContentBold(summaryTitle, document);
                    }
                    
                    String summary = paperEffectSummary.getString("summary");
                    if (StringUtils.isNotBlank(summary)) {
                        setContent(summary, document);
                    }

                    String paperTitle = paperEffectSummary.getString("paperTitle");
                    if (StringUtils.isNotBlank(paperTitle)) {
                        paperTitle = paperTitle.replaceAll("<b>", "").replaceAll("</b>", "");
                        setContentBold(paperTitle, document);
                    }
                    
                    JSONArray paperCon = paperEffectSummary.getJSONArray("paperCon");
                    if (CollectionUtils.isNotEmpty(paperCon)) {
                        for (Object o : paperCon) {
                            JSONArray everyTypePaper = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                            for (Object term : everyTypePaper) {
                                String con = term.toString();
                                con = con.replaceAll("</sup>", "").replaceAll("<sup>", "").replaceAll("<b>", "").replaceAll("</b>", "");
                                setContent(con, document);
                            }
                        }
                    } else {
                        setContent("暂无相关文献。", document);
                    }
                } else {
                    setContent("暂无相关文献。", document);
                }   

                setTitle("四、安全性查询结果", document);
                int safetyCount = 1;
                JSONArray drugInfos = superManualReport.getJSONArray("drugInfos");
                if (CollectionUtils.isNotEmpty(drugInfos)) {
                    setTitle("【4."+ safetyCount++ +" 黑框警告】", document);
                    if (CollectionUtils.isNotEmpty(drugInfos)) {
                        if (drugInfos.size() == 1) {
                            for (Object o : drugInfos) {
                                JSONObject drugInfoObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                                JSONArray warning = drugInfoObj.getJSONArray("warning");
                                if (CollectionUtils.isNotEmpty(warning)) {
                                    assembleListData(warning, document);
                                } else {
                                    String name = drugInfoObj.getString("name");
                                    setContent(name + "药品说明书中未提到黑框警告信息", document);
                                }
                            }
                        } else {
                            for (Object o : drugInfos) {
                                JSONObject drugInfoObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                                String name = drugInfoObj.getString("name");
                                JSONArray warning = drugInfoObj.getJSONArray("warning");
                                setNoFirstLineContent(name + "：", document);
                                if (CollectionUtils.isNotEmpty(warning)) {
                                    assembleListData(warning, document);
                                } else {
                                    setContent("药品说明书中未提到黑框警告信息", document);
                                }
                            }
                        }
                    } else {
                        String drugAndNotStr = superManualReport.getString("drugAndNotStr");
                        setContent(drugAndNotStr + "药品说明书中未提到黑框警告信息", document);
                    }
                }

                JSONObject newsFlash = superManualReport.getJSONObject("newsFlash");
                if (Objects.nonNull(newsFlash)) {
                    int ywjjCount = 1;
                    setTitle("【4."+ safetyCount +" 药物警戒】", document);
                    JSONArray nmpaWord = newsFlash.getJSONArray("nmpaWord");
                    if (CollectionUtils.isNotEmpty(nmpaWord)) {
                        setContentNoRetract(" 4." + safetyCount + "." + ywjjCount++ + " NMPA药物警戒", document);
                        for (Object o : nmpaWord) {
                            setContent(o.toString(), document);
                        }
                    } else {
                        String drugName = newsFlash.getString("drugName");
                        setContent("NMPA未收录" + drugName + "相关的安全警戒信息", document);
                    }
                    safetyCount++;
                }

                if (CollectionUtils.isNotEmpty(drugInfos)) {
                    List<Object> adverseFilterObj = drugInfos.stream().filter(o -> {
                        JSONObject drugInfoObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                        return CollectionUtils.isNotEmpty(drugInfoObj.getJSONArray("adverse"));
                    }).collect(Collectors.toList());

                    if (CollectionUtils.isNotEmpty(adverseFilterObj)) {
                        setTitle("【4."+ safetyCount++ +" 说明书不良反应总结】", document);
                        if (adverseFilterObj.size() == 1) {
                            for (Object o : adverseFilterObj) {
                                JSONObject drugInfoObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                                JSONArray adverse = drugInfoObj.getJSONArray("adverse");
                                String name = drugInfoObj.getString("name");
                                if (CollectionUtils.isNotEmpty(adverse)) {
                                    assembleListData(adverse, document);
                                }
                            }
                        } else {
                            for (Object o : adverseFilterObj) {
                                JSONObject drugInfoObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                                JSONArray adverse = drugInfoObj.getJSONArray("adverse");
                                String name = drugInfoObj.getString("name");
                                if (CollectionUtils.isNotEmpty(adverse)) {
                                    setNoFirstLineContent(name + "：", document);
                                    assembleListData(adverse, document);
                                }
                            }
                        }

                    }
                }

                setTitle("【4."+ safetyCount +" FAERS 数据库】", document);
                JSONObject signalAnalysis = superManualReport.getJSONObject("signalAnalysis");
                if (Objects.nonNull(signalAnalysis)) {
                    
                    JSONObject obj = signalAnalysis.getJSONObject("signalAnalysis");
                    String desc = signalAnalysis.getString("desc");
                    if (Objects.nonNull(obj)) {
                        if (StringUtils.isNotBlank(desc)) {
                            setNoFirstLineContent("    " + desc, document);
                        }
                        
                        JSONArray data = obj.getJSONArray("data");
                        if (CollectionUtils.isNotEmpty(data)) {
                            setNoFirstLineContent("（1）信号分析:", document);
                            setCenterContent("FAERS数据库TOP 20 信号检测表", document);
                            this.createTableForDBAnalysis(data, document);
                        }
                    }
                }

                JSONObject severeAdverseAnalysis = superManualReport.getJSONObject("severeAdverseAnalysis");
                if (Objects.nonNull(severeAdverseAnalysis)) {

                    JSONArray severalAdverse = severeAdverseAnalysis.getJSONArray("severalAdverse");
                    String desc = severeAdverseAnalysis.getString("desc");
                    if (CollectionUtils.isNotEmpty(severalAdverse)) {
                        setNoFirstLineContent("（2）严重不良反应结局分析:", document);
                        setNoFirstLineContent("    " + desc, document);
                        createTableForSeveralAdverse(severalAdverse, document);
                    }
                }

                setTitle("五、分析结论：", document);
                JSONArray analysisConclusion = superManualReport.getJSONArray("analysisConclusion");
                if (CollectionUtils.isNotEmpty(analysisConclusion)) {
                    for (Object o : analysisConclusion) {
                        setContent(o.toString(), document);
                    }
                } else {
                    setContent("暂无内容", document);
                }

                setTitle("参考文献", document);
                JSONArray bibliographys = superManualReport.getJSONArray("bibliographys");
                if (CollectionUtils.isNotEmpty(bibliographys)) {
                    for (int i = 0; i < bibliographys.size(); i++) {
                        setNoFirstLineContent(bibliographys.getString(i), document);
                    }
                } else {
                    setContent("暂无内容", document);
                }

                //六、附录：
                JSONArray literature = superManualReport.getJSONArray("literature");
                if (CollectionUtils.isNotEmpty(literature)) {
                    document.newPage();
                    setTitle("附录：", document);
                    createTableForLiteratureMutilField(literature, document);
                }    
                
//            setTitle("附录一、“推荐等级”评价标准", document);
//            Paragraph blankSpace = new Paragraph("");
//            Font blankSize = new Font(null, 12, Font.NORMAL);
//            blankSpace.setFont(blankSize);
//            for (int i = 0; i < 1; i++) {
//                document.add(blankSpace);
//            }
//            Image image = null;
//            try {
//                //添加图片
//                ClassPathResource classPathResource = new ClassPathResource("/image/recommendCriteria.jpg");
//                InputStream inputStreamImg = classPathResource.getInputStream();
//                BufferedImage read = ImageIO.read(inputStreamImg);
//                //通过将文件转换为临时文件进行操作
//                File imgFile = File.createTempFile("recommendCriteria", ".jpg");
//                ImageIO.write(read, "jpg", imgFile);
//                image = Image.getInstance(String.valueOf(imgFile));
//            } catch (Exception e) {
//                log.error("读取图片文件出现异常，{}", ExceptionUtils.getFullStackTrace(e));
//            }
//            if (image != null) {
//                image.setAlignment(Element.ALIGN_LEFT);
//                //依照比例缩放
//                image.scalePercent(71f);
//                // 设置图片的显示大小
//                //image1.scaleToFit(700, 871);
//                image.setSpacingBefore(20f);
//                document.add(image);
//            }
                //设置页面
                setPageNum(document);
                document.close();
                log.info("报告下载完成");
            } catch (IOException | DocumentException e) {
                log.error(e.getMessage(), e);
            }
        }
    }

    @Override
    public JSONObject showPc(String id) {
        if (StringUtils.isNotBlank(id)) {
            // 做适配
            JSONObject superManualReport = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
            if (Objects.nonNull(superManualReport)) {
                Double reportVersion = superManualReport.getDouble("reportVersion");
                String redisVersion = RedisUtils.getStr("superReportVersion");
                if (Objects.isNull(reportVersion) || reportVersion < Double.parseDouble(redisVersion)) {
                    superManualReport.put("reportRefresh", true);
                }  else {
                    superManualReport.put("reportRefresh", false);
                }
                return superManualReport;
            }
        }
        return null;
    }

    @Override
    public String createToken(String id, long userId, HttpServletRequest request) {
        String token = jwtUtils.createTokenByIdAndUid(id, userId);
        RedisUtils.set(Constants.REPORT_TOKEN + userId + ":" + id, token, 30 * 60, TimeUnit.SECONDS);
        return token;
    }

    @Override
    public JSONObject show(String id) {
        if (StringUtils.isNotBlank(id)) {
            // 做适配
            JSONObject superManualReport = mongoTemplate.findById(id, JSONObject.class, "super_manual_Report");
            if (Objects.nonNull(superManualReport)) {
                Double reportVersion = superManualReport.getDouble("reportVersion");
                String redisVersion = RedisUtils.getStr("superReportVersion");
                if (Objects.isNull(reportVersion) || reportVersion < Double.parseDouble(redisVersion)) {
                    superManualReport.put("reportRefresh", true);
                }  else {
                    superManualReport.put("reportRefresh", false);
                }
                return superManualReport;
            }
        }
        return null;
    }

    @Override
    public boolean changeCache(JSONObject dataJson) {
        JSONObject remove = null;
        try {
            String id = dataJson.getString("_id");
            remove = mongoTemplate.findAndRemove(new Query(Criteria.where("_id").is(id)), JSONObject.class, "super_manual_Report");
            mongoTemplate.save(dataJson, "super_manual_Report");
            return true;
        } catch (Exception e) {
            log.error("修改后数据缓存失败，缓存数据回退");
            if (remove != null) {
                mongoTemplate.save(remove, "super_manual_Report");
            }
        }
        return false;
    }





    /**
     * 处理初始数据
     */
    private void handleInitialData(Condition condition, JSONObject result) {
        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();

        assembleDrug(drugs, result);
        assembleDisease(diseases, result);
        assembleCompareDrug(condition.getInterventions(), result);
        assembleOutcomes(condition.getOutcomes(), result);
        assembleStudyType(condition.getStudyType(), result);

        DrugDto drugDto = new DrugDto();
        drugDto.setDrugs(drugs);
        drugDto.setIsTranslate(condition.getIsTranslate());
        drugDto.setPageNum(1);
        drugDto.setPageSize(1000);
        drugDto.setSearch("");
        result.put("drugDto", drugDto);
    }

    private void assembleDisease(List<Disease> diseases, JSONObject result) {
        result.put("diseaseAndNotStr", "---");
        
        boolean isRejected = false;
        
        List<Disease> diseaseAnd = new ArrayList<>();
        List<String> diseaseAndWord = new ArrayList<>();
        StringBuilder diseaseAndNotStr = new StringBuilder();
        for (Disease disease : diseases) {
            if (disease.getStatus() == 1) {
                if (!isRejected) {
                    diseaseAnd.add(disease);
                    diseaseAndWord.add(disease.getWord());
                    diseaseAndNotStr.append(disease.getWord());
                } else {
                    isRejected = false;
                    diseaseAndNotStr.append(disease.getWord());
                }
            }
            if (disease.getStatus() == 2) {
                diseaseAndNotStr.append("&");
            }
            if (disease.getStatus() == 3) {
                isRejected = true;
                diseaseAndNotStr.append("!");
            }
        }
        result.put("diseaseAnd", diseaseAnd);
        result.put("diseaseAndWord", diseaseAndWord);
        result.put("diseaseAndNotStr", diseaseAndNotStr.toString());
    }

    private void assembleDrug(List<Drug> drugs, JSONObject result) {
        result.put("drugAndNotStr", "---");
        
        if (CollUtil.isEmpty(drugs)) return;

        boolean isRejected = false;
        List<Drug> drugAnd = new ArrayList<>(); 
        List<String> drugAndWord = new ArrayList<>(); 
        List<Drug> drugNot = new ArrayList<>(); 
        StringBuilder drugAndNotStr = new StringBuilder();
        for (Drug drug : drugs) {
            if (drug.getStatus() == 1) {
                if (!isRejected) {
                    drugAnd.add(drug);
                    drugAndWord.add(drug.getWord());
                    drugAndNotStr.append(drug.getWord());
                } else {
                    drugNot.add(drug);
                    drugAndNotStr.append(drug.getWord());
                    isRejected = false;
                }
            }
            if (drug.getStatus() == 2) {
                drugAndNotStr.append("&");
            }
            if (drug.getStatus() == 3) {
                isRejected = true;
                drugAndNotStr.append("!");
            }
        }
        result.put("drugAnd", drugAnd);
        result.put("drugAndWord", drugAndWord);
        result.put("drugNot", drugNot);
        result.put("drugAndNotStr", drugAndNotStr.toString());
        result.put("otherDrugWord", "");
        if (CollectionUtils.isNotEmpty(drugs)) {
            result.put("firstDrugWord", drugs.get(0).getWord());

            List<Drug> filter = drugs.stream().filter(o -> o.getStatus() == 1).collect(Collectors.toList());
            filter.remove(0);
            if (CollectionUtils.isNotEmpty(filter)) {
                result.put("otherDrugWord", filter.stream().map(Drug::getWord). collect(Collectors.joining("联合")));
            }
        }
       
    }

    private void assembleCompareDrug(List<InterventionAndOutcome> compareDrugs, JSONObject result) {
        result.put("compareDrugAndNotStr", "---");
        
        if (CollUtil.isEmpty(compareDrugs)) return;
        
        boolean isRejected = false;
        List<InterventionAndOutcome> compareDrugAnd = new ArrayList<>();
        List<String> compareDrugAndWord = new ArrayList<>();
        List<InterventionAndOutcome> compareDrugNot = new ArrayList<>();
        StringBuilder compareDrugAndNotStr = new StringBuilder();
        
        for (InterventionAndOutcome compareDrug : compareDrugs) {
            if (compareDrug.getStatus() == 1) {
                if (!isRejected) {
                    compareDrugAndNotStr.append(compareDrug.getWord());
                    compareDrugAnd.add(compareDrug);
                    compareDrugAndWord.add(compareDrug.getWord());
                } else {
                    compareDrugNot.add(compareDrug);
                    compareDrugAndNotStr.append(compareDrug.getWord());
                    isRejected = false;
                }
            }
            if (compareDrug.getStatus() == 2) {
                compareDrugAndNotStr.append("&");
            }
            if (compareDrug.getStatus() == 3) {
                isRejected = true;
                compareDrugAndNotStr.append("!");
            }
        }
        result.put("compareDrugAnd", compareDrugAnd);
        result.put("compareDrugAndWord", compareDrugAndWord);
        result.put("compareDrugNot", compareDrugNot);
        result.put("compareDrugAndNotStr", compareDrugAndNotStr.toString());
    }

    private void assembleOutcomes(List<InterventionAndOutcome> compareDrugs, JSONObject result) {
        result.put("outcomeAndNotStr", "---");
        if (CollUtil.isEmpty(compareDrugs)) return;
        boolean isRejected = false;
        StringBuilder outcomeAndNotStr = new StringBuilder();
        for (InterventionAndOutcome compareDrug : compareDrugs) {
            if (compareDrug.getStatus() == 1) {
                outcomeAndNotStr.append(compareDrug.getWord());
                if (isRejected) {
                    isRejected = false;
                }
            }
            if (compareDrug.getStatus() == 2) {
                outcomeAndNotStr.append("&");
            }
            if (compareDrug.getStatus() == 3) {
                isRejected = true;
                outcomeAndNotStr.append("!");
            }
        }
        result.put("outcomeAndNotStr", outcomeAndNotStr.toString());
    }

    private void assembleStudyType(List<Integer> studyType, JSONObject result) {
        result.put("studyTypeStr", "---");
        
        if (CollUtil.isEmpty(studyType)) return;
        
        StringBuilder studyTypeStr = new StringBuilder();
        for (Integer type : studyType) {
            switch (type) {
                case 0:
                    studyTypeStr.append("Review、");
                    continue;
                case 1:
                    studyTypeStr.append("病例系列/病例报告、");
                    continue;
                case 2:
                case 8:
                case 9:
                    studyTypeStr.append(" ");
                    continue;
                case 3:
                    studyTypeStr.append("系统评价/Meta分析、");
                    continue;
                case 4:
                    studyTypeStr.append("RCT/nRCT、");
                    continue;
                case 5:
                    studyTypeStr.append("观察性研究、");
                    continue;
                case 6:
                    studyTypeStr.append("经济学研究、");
                    continue;
                case 7:
                    studyTypeStr.append("临床试验、");
                    continue;
                default:
                    break;
            }
        }
        String substring = studyTypeStr.toString();
        if (StringUtils.isNotBlank(studyTypeStr)) {
            substring = studyTypeStr.substring(0, studyTypeStr.length() - 1);
        }
        result.put("studyTypeStr", substring);
    }

    public static boolean checkFullWordContain(String text, List<String> synonym) {
        boolean match = false;

        text = text.replaceAll("\n", "");
        boolean chinese = text.matches(".*[\u4e00-\u9fff].*");
        boolean english = text.matches(".*[a-zA-Z].*");
        if (english) {
            for (String word : synonym) {
                // 对特殊字符进行转义
                word = word.replaceAll("([+\\-\\[\\]{}()*^$.|?])", "\\\\$1");
                // 使用正则表达式来匹配完整的单词
                String pattern = "\\b" + word + "\\b";
                Pattern compiledPattern = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
                Matcher matcher = compiledPattern.matcher(text);
                if (matcher.find()) {
                    match = true;
                    break;
                }
//                if (text.matches(".*" + pattern + ".*")) {
//                    match = true;
//                    break;
//                }
            }
            if (chinese) {
                match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
            }
        } else {
            match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
        }
        return match;
    }

    private String verifyTokenValid(String verifyToken) {
        Map<String, Claim> claim = jwtUtils.verifyToken(verifyToken);
        if (MapUtil.isNotEmpty(claim)) {
            Long uid = claim.get("uid").asLong();
            String questionId = claim.get("questionId").asString();
            String token = RedisUtils.getStr(Constants.REPORT_TOKEN + uid + ":" + questionId);
            if (StringUtils.isNotBlank(token)) {
                return token;
            }
        }
        return "";
    }

    private void tokenInvalid(String verifyToken) {
        Map<String, Claim> claim = jwtUtils.verifyToken(verifyToken);
        if (MapUtil.isNotEmpty(claim)) {
            Long uid = claim.get("uid").asLong();
            String questionId = claim.get("questionId").asString();
            String token = RedisUtils.getStr(Constants.REPORT_TOKEN + uid + ":" + questionId);
            if (StringUtils.isNotBlank(token)) {
                // 删除 token 使其失效
                RedisUtils.del(Constants.REPORT_TOKEN + uid + ":" + questionId);
            }
        }
    }

    /**
     * 拼接标题
     */
    private String getInfo(Condition condition) {
        StringBuilder info = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        if (CollectionUtils.isNotEmpty(drugs)){
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1){
                    info.append(drug.getWord());
                } else if (status == 2){
                    //与
                    info.append("联合");
                }else {
                    //非
                    info.append("排除");
                }
            }
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            info.append("用于");
            for (Disease disease : diseases) {
                Integer status = disease.getStatus();
                if (status == 1){
                    info.append(disease.getWord());
                }else if (status == 2){
                    //与
                    info.append("合并");
                }else {
                    //非
                    info.append("排除");
                }
            }
        }
        return info.toString();
    }
    
    /**
     * 国内外说明书
     */
    private void indication(Condition condition, JSONObject result, JSONObject data, int referenceCount) {
        String drugAndNotStr = result.getString("drugAndNotStr").replaceAll("&", "合并");
        String diseaseAndNotStr = result.getString("diseaseAndNotStr").replaceAll("&", "联合");
        String otherDrugWord = result.getString("otherDrugWord");
        String firstDrugWord = result.getString("firstDrugWord");
        if (StrUtil.isBlank(firstDrugWord)) {
            firstDrugWord = drugAndNotStr;
        }
        
        data.put("drugAndNotStr", result.getString("drugAndNotStr"));

        Map<Integer, String> map = new HashMap<>();

        String finalFirstDrugWord = firstDrugWord;
        CompletableFuture<Void> indicationCom = CompletableFuture.runAsync(() -> {
            String conclusion = "";
            
            boolean isApproved = false;
            
            BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQueryAndP(condition);
            List<String> sources = Arrays.asList("用药助手", "用药参考");
            instructionQuery.must().add(QueryBuilders.termsQuery("source", sources));
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
            nativeSearchQuery.setMaxResults(1000);
            SearchHits<InstructionIndex> searchHits = null;
            String indication = "";
            try {
                searchHits = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index")),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
                indication = searchHits.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
            } catch (Exception e) {
                log.error("NMPA查询错误: {}", e.getMessage(), e);
            }
            if (StringUtils.isNotBlank(indication)) {
                // 构建问题字符串...
                String question_2 = "请你作为临床药学专家，严格依据药品说明书内容判断目标疾病是否属于超适应证用药。请遵循以下准则：\n" +
                        "1. **核心原则**：仅承认说明书中明确描述或通过医学术语逻辑可推导的适应症\n" +
                        "   - 排除疾病名称的表面相似性（如\"肺炎\"≠\"间质性肺炎\"）\n" +
                        "   - 排除疾病名称包含间的相似性（如\"2型糖尿病\"≠\"糖尿病\"）\n" +
                        "   - 警惕限定条件（如\"细菌性感染\"不包含病毒性感染）\n" +
                        "   - 区分病症层级（\"心血管疾病\"包含\"冠心病\"，但\"稳定型心绞痛\"不包含\"不稳定型\"）\n" +
                        "\n" +
                        "2. **判断流程**：\n" +
                        "   [1] 定位说明书中的适应症描述段\n" +
                        "   [2] 提取关键医学实体及其限定词（病原体类型/分期/分型等）\n" +
                        "   [3] 建立疾病逻辑映射：\n" +
                        "     ✅ 直接匹配（说明书：\"HER2阳性乳腺癌\" → 目标：\"HER2阳性乳腺癌\"）\n" +
                        "     ✅ 合理包含（说明书：\"实体瘤\" → 目标：\"非小细胞肺癌\"）\n" +
                        "     ❌ 扩展包含（说明书：\"绝经后乳腺癌\" → 目标：\"乳腺癌\"）\n" +
                        "   [4] 特别注意排除性描述（如\"不适用于XX型\"）\n" +
                        "\n" +
                        "3. **返回规则**：\n" +
                        "   - 仅返回单个布尔值（无需解释）\n" +
                        "   - true = 超适应症（疾病不在说明书范围内）\n" +
                        "   - false = 合规用药（疾病明确包含）\n" +
                        "疾病或症状名：{" + diseaseAndNotStr + "}\n" +
                        "药品名：{" + finalFirstDrugWord + "}\n" +
                        "说明书内容：{" + indication + "}";
                try {
                    String judgeResult = retryUtils.executeWithRetry(question_2, Constants.QWEN3_MAX_600_PRM, String.class, "nmpa 超适应症判断", PriorityConstants.PRIORITY_NORMAL, true);

                    if (StringUtils.isNotBlank(judgeResult)) {
                        String trimmedResult = judgeResult.trim();

                        if ("false".equals(trimmedResult)) {
                            conclusion = drugAndNotStr + "用于" + diseaseAndNotStr + "的治疗属于超适应症用药。";
                        } else if ("true".equals(trimmedResult)) {
                            isApproved = true;
                            conclusion = drugAndNotStr + "用于" + diseaseAndNotStr + "的治疗不属于超适应症用药。";
                        }
                    }
                } catch (Exception e) {
                    log.error("超适应症判断错误: {}", e.getMessage(), e);
                    conclusion = drugAndNotStr + "用于" + diseaseAndNotStr + "的治疗不属于超适应症用药。";
                }
            } else {
                conclusion = drugAndNotStr + "用于" + diseaseAndNotStr + "的治疗属于超适应症用药。";
            }
            
            if (StrUtil.isBlank(indication)) {
                String searchNMPAPrompt = "请根据以下要求提供药品【" + finalFirstDrugWord + "】的适应症信息：\n" +
                        "\n" +
                        "1. **适应症概述**：列出该药品所有已获批的适应症，按疾病类型分类整理\n" +
                        "\n" +
                        "2. **详细适应症内容**：\n" +
                        "   - 特应性皮炎：适用范围、患者群体、使用限制\n" +
                        "   - 类风湿关节炎：适用范围、患者群体、使用限制  \n" +
                        "   - 银屑病关节炎：适用范围、患者群体、使用限制\n" +
                        "   - 溃疡性结肠炎：适用范围、患者群体、使用限制\n" +
                        "   - 克罗恩病：适用范围、患者群体、使用限制\n" +
                        "   - 其他适应症：（如适用）\n" +
                        "\n" +
                        "3. **使用限制和注意事项**：\n" +
                        "   - 不推荐联合使用的药物\n" +
                        "   - 特殊人群使用限制\n" +
                        "   - 年龄限制\n";
                indication = AIRequestUtils.modelStudio(searchNMPAPrompt, Constants.QWEN3_MAX_2025_09_23_60_PRM);
                if (indication.startsWith("未查询")) {
                    indication = "";
                } else {
                    indication = indication.replaceAll("\n", "");
                }
            }
            
            if (StringUtils.isNotBlank(indication)) {
                String nmpaPrompt = "请对提供的NMPA适应症文本执行以下操作：\n" +
                        "\n" +
                        "进行专业医学维度分析，合并重复表述及同质化内容（含不同表述形式但治疗目标一致的情形）\n" +
                        "基于治疗领域进行逻辑归类，按照临床适用场景的优先级排序\n" +
                        "用简洁的医学术语重构内容，去除所有说明性引导语（如\"用于\"\"适用于\"等开头词）\n" +
                        "形成连贯的自然段落，使用中文标点规范分隔不同适应症类别。\n" +
                        "结果内容中，需要删除所有与适应症不想关的内容。如：xxx的适应症涵盖多个领域；对于最新信息，建议查询NMPA官网或药品注册证数据库。\n" +
                        "给定的NMPA适应症为：\n" + indication;

                String gpt4oSummary;
                try {
                    gpt4oSummary = retryUtils.executeWithRetry(nmpaPrompt, "", String.class, "nmpa适应症合并内容", PriorityConstants.PRIORITY_NORMAL, true);
                    gpt4oSummary = gpt4oSummary.replaceAll("\n", "");
                } catch (Exception e) {
                    gpt4oSummary = indication;
                }

                indication = gpt4oSummary;
            }

            if (isApproved) {
                map.put(1, "NMPA-" + finalFirstDrugWord);
            }

            if (StringUtils.isNotBlank(indication)) {
                indication = "查看" + finalFirstDrugWord + "NMPA药品说明书：" + "\n" + indication;
                if (!indication.endsWith("。")) {
                    indication += "。";
                }
            }

            data.put("conclusion", conclusion);
            data.put("indication", indication);
        }, reportExecutor);

        String finalFirstDrugWord1 = firstDrugWord;
        CompletableFuture<Void> fdaCom = CompletableFuture.runAsync(() -> {

            String indicationFda = "美国FDA未批准" + drugAndNotStr + "用于" + diseaseAndNotStr + "患者的治疗；";
                    
            boolean isApproved = false;

            BoolQueryBuilder instructionQuery_fda = QueryUtils.createInstructionQueryAndP(condition);
            instructionQuery_fda.must().add(QueryBuilders.termQuery("source", "fda"));
            NativeSearchQuery nativeSearchQuery_fda = new NativeSearchQuery(instructionQuery_fda);
            nativeSearchQuery_fda.setMaxResults(1000);
            
            SearchHits<InstructionIndex> searchHits_fda = null;
            String instruction_fda = "";
            try {
                searchHits_fda = elasticsearchRestTemplate.search(nativeSearchQuery_fda, InstructionIndex.class);
                instruction_fda  = searchHits_fda.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
            } catch (Exception e) {
                log.error("FDA查询错误: {}", e.getMessage(), e);
            }
            if (StringUtils.isNotBlank(instruction_fda)) {
                String fdaJudgePrompt = "作为临床药师，请严格遵循以下步骤分析：\n"
                        + "1. 深入解读FDA说明书内容，判断目标疾病是否在说明书适应症范围内\n"
                        + "2. 判断标准：\n"
                        + "   - 对输入数据进行动态解析：\n"
                        + "      a) 药品名称：使用'联合'拆分为列表，若为空则跳过药品共现判断\n"
                        + "      b) 疾病名称：使用'合并'拆分为列表，若为空视为无效输入\n"
                        + "   - 动态术语处理：\n"
                        + "      a) 当输入为中文药品名时，使用国际通用英文名称及首字母缩写\n"
                        + "         （例：'苯磺酸氨氯地平'对应'Amlodipine Besylate'和'AB'）\n"
                        + "      b) 当输入为英文药品名时，补充国际通用中文译名及完整拼写\n"
                        + "         （例：'Enalapril'需同时匹配'依那普利'和'Enalapril Maleate'）\n"
                        + "      c) 疾病名称需双向匹配ICD-11编码、SNOMED-CT术语及常见别名\n"
                        + "         （例：'心衰'需匹配'Heart Failure','HF','心力衰竭'）\n"
                        + "   - 动态匹配逻辑：\n"
                        + "      a) 当药品名称非空时：\n"
                        + "         - 所有药品的中英文及缩写必须共现于同一适应症描述\n"
                        + "         - 联用表述需同时满足药物组合形式（如'X+Y'或'X联合Y'）\n"
                        + "      b) 当药品名称为空时：\n"
                        + "         - 只需疾病列表中的名称在适应症文本中完整匹配\n"
                        + "      c) 当疾病列表包含多病时：\n"
                        + "         - 所有疾病术语（含ICD编码/别名）需共现于同一适应症\n"
                        + "         - 需存在合并治疗表述（如'治疗...合并症','combination therapy'）\n"
                        + "   - 安全性过滤：\n"
                        + "      a) 排除适应症前后存在否定性限定（not/除外/contraindicated）\n"
                        + "      b) 标注为加速批准(accelerated approval)视为未批准\n"
                        + "      c) 适应症必须明确列示于INDICATIONS AND USAGE章节\n"
                        + "3. 输出规范：\n"
                        + "   - 严格使用JSON格式，仅包含result字段\n"
                        + "   - result为布尔值：true=疾病明确获得批准，false=未批准\n"
                        + "   - 禁止任何额外文本或错误说明\n"
                        + "4. 输入数据：\n"
                        + "   - 药品名称：{{" + finalFirstDrugWord1 + "}}\n"
                        + "   - 疾病名称：{{" + diseaseAndNotStr + "}}\n"
                        + "   - FDA说明书适应症内容：{{" + instruction_fda + "}}\n"
                        + "请严格按此结构输出：\n"
                        + "{\"result\": false}\n"
                        + "注意：任何不符合要求的格式都将导致解析失败";

                try {
                    Date oneDate = new Date();
                    String fda = "";

                    // gpt-4o-2024-11-20
                    JSONObject aiResult = retryUtils.executeWithRetry(fdaJudgePrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "fda适应症是否获批", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiResult)) {
                        fda = aiResult.getString("result");
                    }
                    if (StringUtils.isNotBlank(fda) && "true".equals(fda)) {
                        indicationFda = indicationFda.replaceAll("未批准", "已批准");
                        isApproved = true;
                        result.put("fda", true);
                    }
                    long processingTime = new Date().getTime() - oneDate.getTime();
                    log.info("说明书米国 fda 适应证总结完成，花费时间{}ms", processingTime);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);
                instructionQuery.must().add(QueryBuilders.termQuery("source", "fda"));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
                nativeSearchQuery.setMaxResults(20);
                
                SearchHits<InstructionIndex> searchHits = null;
                try {
                    searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class);
                    instruction_fda  = searchHits.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
                } catch (Exception e) {
                    log.error("FDA查询错误: {}", e.getMessage(), e);
                }
            }

            if (StringUtils.isNotBlank(instruction_fda)) {
                StringBuilder builder = new StringBuilder(indicationFda).append("\n");
                
                String summaryPrompt = "你是一位专业的医学翻译专家，请按以下步骤处理文本：\n"
                        + "1. 先对提供的说明书内容进行专业总结（不要遗漏剂量和人群信息）\n"
                        + "2. 然后将总结内容，保持跟原语言一致。\n"
                        + "3. 返回格式要求：\n"
                        + "```json\n"
                        + "{\n"
                        + "  \"original\": \"[保持跟原语言一致的总结内容]\",\n"
                        + "  \"translated\": \"[包含专业术语的中文翻译]\"\n"
                        + "}\n"
                        + "```\n"
                        + "严格要求：\n"
                        + "- 必须使用医学专业术语\n"
                        + "- 保留所有数字、剂量和专业术语原文\n"
                        + "- 不添加任何额外信息\n"
                        + "- 忠实于原文的临床意义\n"
                        + "4. 请只返回JSON格式数据体。\n"
                        + "输入文本：{{" + instruction_fda + "}}\n";

                try {
                    // gpt-4o-2024-11-20
                    JSONObject aiSummaryResult = retryUtils.executeWithRetry(summaryPrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "fda适应症总结", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiSummaryResult)) {
                        String original = aiSummaryResult.getString("original");
                        if (StringUtils.isNotBlank(original)) {
                            original = original.replaceAll("\n", "");
                            builder.append("适应症：\n").append(original).append("\n");
                        }

                        String translated = aiSummaryResult.getString("translated");
                        if (StringUtils.isNotBlank(translated)) {
                            translated = translated.replaceAll("\n", "");
                            builder.append("译文：\n").append(translated);
                        }
                    }
                    indicationFda = builder.toString();
                } catch (Exception e) {
                    log.error("生成FDA适应症总结时发生错误: {}", e.getMessage(), e);
                }
            } else {
                String extraInfo = "暂未查询到 FDA 关于" + finalFirstDrugWord + "的适应症信息";
                indicationFda = indicationFda + "\n" + extraInfo;
            }

            data.put("indicationFda", indicationFda);
            
            if (isApproved) {
                map.put(2, "FDA-" + finalFirstDrugWord);
            }
            //String activeProfile = environment.getActiveProfiles()[0];
            //                    if (StringUtils.isNotBlank(activeProfile)) {
            //                        if ("dev".equals(activeProfile)) {
            //                            pdfUrl = "http://192.168.20.252:2032/specification?pdfName=" + fdaInstruction.getPdf_name() + "&source=fda";
            //                        } else if ("release".equals(activeProfile)) {
            //                            pdfUrl = "https://syshospital-offlabel.evimed.com/specification?pdfName=" + fdaInstruction.getPdf_name() + "&source=fda";
            //                        }
            //                    } else {
            //                        pdfUrl = "https://syshospital-offlabel.evimed.com/specification?pdfName=" + fdaInstruction.getPdf_name() + "&source=fda";
            //                    }

        }, reportExecutor);

        String finalFirstDrugWord2 = firstDrugWord;
        CompletableFuture<Void> emaCom = CompletableFuture.runAsync(() -> {
            String indicationEma = "欧洲EMA未批准" + drugAndNotStr + "用于" + diseaseAndNotStr + "患者的治疗；";
            
            boolean isApproved = false;

            BoolQueryBuilder instructionQuery_ema = QueryUtils.createInstructionQueryAndP(condition);
            instructionQuery_ema.must().add(QueryBuilders.termQuery("source", "ema"));
            NativeSearchQuery nativeSearchQuery_ema = new NativeSearchQuery(instructionQuery_ema);
            nativeSearchQuery_ema.setMaxResults(1000);
            SearchHits<InstructionIndex> searchHits_ema = null;
            String instruction_ema = "";
            try {
                searchHits_ema = elasticsearchRestTemplate.search(nativeSearchQuery_ema, InstructionIndex.class);
                instruction_ema  = searchHits_ema.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
            } catch (Exception e) {
                log.error("EMA查询错误: {}", e.getMessage(), e);
            }
            if (StringUtils.isNotBlank(instruction_ema)) {
                String fdaJudgePrompt = "作为临床药师，请严格遵循以下步骤分析：\n"
                        + "1. 深入解读EMA说明书内容，判断目标疾病是否在说明书适应症范围内\n"
                        + "2. 判断标准：\n"
                        + "   - 对输入数据进行动态解析：\n"
                        + "      a) 药品名称：使用'联合'拆分为列表，若为空则跳过药品共现判断\n"
                        + "      b) 疾病名称：使用'合并'拆分为列表，若为空视为无效输入\n"
                        + "   - 动态术语处理：\n"
                        + "      a) 当输入为中文药品名时，使用国际通用英文名称及首字母缩写\n"
                        + "         （例：'苯磺酸氨氯地平'对应'Amlodipine Besylate'和'AB'）\n"
                        + "      b) 当输入为英文药品名时，补充国际通用中文译名及完整拼写\n"
                        + "         （例：'Enalapril'需同时匹配'依那普利'和'Enalapril Maleate'）\n"
                        + "      c) 疾病名称需双向匹配ICD-11编码、SNOMED-CT术语及常见别名\n"
                        + "         （例：'心衰'需匹配'Heart Failure','HF','心力衰竭'）\n"
                        + "   - 动态匹配逻辑：\n"
                        + "      a) 当药品名称非空时：\n"
                        + "         - 所有药品的中英文及缩写必须共现于同一适应症描述\n"
                        + "         - 联用表述需同时满足药物组合形式（如'X+Y'或'X联合Y'）\n"
                        + "      b) 当药品名称为空时：\n"
                        + "         - 只需疾病列表中的名称在适应症文本中完整匹配\n"
                        + "      c) 当疾病列表包含多病时：\n"
                        + "         - 所有疾病术语（含ICD编码/别名）需共现于同一适应症\n"
                        + "         - 需存在合并治疗表述（如'治疗...合并症','combination therapy'）\n"
                        + "   - 安全性过滤：\n"
                        + "      a) 排除适应症前后存在否定性限定（not/除外/contraindicated）\n"
                        + "      b) 标注为加速批准(accelerated approval)视为未批准\n"
                        + "      c) 适应症必须明确列示于INDICATIONS AND USAGE章节\n"
                        + "3. 输出规范：\n"
                        + "   - 严格使用JSON格式，仅包含result字段\n"
                        + "   - result为布尔值：true=疾病明确获得批准，false=未批准\n"
                        + "   - 禁止任何额外文本或错误说明\n"
                        + "4. 输入数据：\n"
                        + "   - 药品名称：{{" + finalFirstDrugWord2 + "}}\n"
                        + "   - 疾病名称：{{" + diseaseAndNotStr + "}}\n"
                        + "   - EMA说明书适应症内容：{{" + instruction_ema + "}}\n"
                        + "请严格按此结构输出：\n"
                        + "{\"result\": false}\n"
                        + "注意：任何不符合要求的格式都将导致解析失败";

                try {
                    Date oneDate = new Date();
                    String ema = "";

                    // gpt-4o-2024-11-20
                    JSONObject aiResult = retryUtils.executeWithRetry(fdaJudgePrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "fda适应症是否获批", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiResult)) {
                        ema = aiResult.getString("result");
                    }
                    if (StringUtils.isNotBlank(ema) && "true".equals(ema)) {
                        indicationEma = indicationEma.replaceAll("未批准", "已批准");
                        isApproved = true;
                        result.put("ema", true);
                    }
                    long processingTime = new Date().getTime() - oneDate.getTime();
                    log.info("说明书欧洲 EMA 适应证总结完成，花费时间{}ms", processingTime);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);
                instructionQuery.must().add(QueryBuilders.termQuery("source", "fda"));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
                nativeSearchQuery.setMaxResults(20);

                SearchHits<InstructionIndex> searchHits = null;
                try {
                    searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class);
                    instruction_ema  = searchHits.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
                } catch (Exception e) {
                    log.error("EMA查询错误: {}", e.getMessage(), e);
                }
            }

            // 生成最终的FDA适应症信息
            if (StringUtils.isNotBlank(instruction_ema)) {
                StringBuilder builder = new StringBuilder(indicationEma).append("\n");

                String summaryPrompt = "你是一位专业的医学翻译专家，请按以下步骤处理文本：\n"
                        + "1. 先对提供的说明书内容进行专业总结（不要遗漏剂量和人群信息）\n"
                        + "2. 然后将总结内容，保持跟原语言一致。\n"
                        + "3. 返回格式要求：\n"
                        + "```json\n"
                        + "{\n"
                        + "  \"original\": \"[保持跟原语言一致的总结内容]\",\n"
                        + "  \"translated\": \"[包含专业术语的中文翻译]\"\n"
                        + "}\n"
                        + "```\n"
                        + "严格要求：\n"
                        + "- 必须使用医学专业术语\n"
                        + "- 保留所有数字、剂量和专业术语原文\n"
                        + "- 不添加任何额外信息\n"
                        + "- 忠实于原文的临床意义\n"
                        + "4. 请只返回JSON格式数据体。\n"
                        + "输入文本：{{" + instruction_ema + "}}\n";

                try {
                    // gpt-4o-2024-11-20
                    JSONObject aiSummaryResult = retryUtils.executeWithRetry(summaryPrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "fda适应症总结", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiSummaryResult)) {
                        String original = aiSummaryResult.getString("original");
                        if (StringUtils.isNotBlank(original)) {
                            original = original.replaceAll("\n", "");
                            builder.append("适应症：\n").append(original).append("\n");
                        }

                        String translated = aiSummaryResult.getString("translated");
                        if (StringUtils.isNotBlank(translated)) {
                            translated = translated.replaceAll("\n", "");
                            builder.append("译文：\n").append(translated);
                        }
                    }
                    indicationEma = builder.toString();
                } catch (Exception e) {
                    log.error("生成EMA适应症总结时发生错误: {}", e.getMessage(), e);
                }
            } else {
                String extraInfo = "暂未查询到 EMA 关于" + finalFirstDrugWord + "的适应症信息";
                indicationEma = indicationEma + "\n" + extraInfo;
            }

            data.put("indicationEma", indicationEma);
            if (isApproved) {
              map.put(3, "EMA-" + finalFirstDrugWord);
            }
        }, reportExecutor);

        String finalFirstDrugWord3 = firstDrugWord;
        CompletableFuture<Void> pmdaCom = CompletableFuture.runAsync(() -> {
            String indicationPmda = "日本PMDA未批准" + drugAndNotStr + "用于" + diseaseAndNotStr + "患者的治疗；";
            
            boolean isApproved = false;

            BoolQueryBuilder instructionQuery_pmda = QueryUtils.createInstructionQueryAndP(condition);
            instructionQuery_pmda.must().add(QueryBuilders.termQuery("source", "pmda"));
            NativeSearchQuery nativeSearchQuery_pmda = new NativeSearchQuery(instructionQuery_pmda);
            nativeSearchQuery_pmda.setMaxResults(1000);
            SearchHits<InstructionIndex> searchHits_pmda = null;
            String instruction_pmda = "";
            try {
                searchHits_pmda = elasticsearchRestTemplate.search(nativeSearchQuery_pmda, InstructionIndex.class);
                instruction_pmda  = searchHits_pmda.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
            } catch (Exception e) {
                log.error("EMA查询错误: {}", e.getMessage(), e);
            }
            if (StringUtils.isNotBlank(instruction_pmda)) {
                String fdaJudgePrompt = "作为临床药师，请严格遵循以下步骤分析：\n"
                        + "1. 深入解读PMDA说明书内容，判断目标疾病是否在说明书适应症范围内\n"
                        + "2. 判断标准：\n"
                        + "   - 对输入数据进行动态解析：\n"
                        + "      a) 药品名称：使用'联合'拆分为列表，若为空则跳过药品共现判断\n"
                        + "      b) 疾病名称：使用'合并'拆分为列表，若为空视为无效输入\n"
                        + "   - 动态术语处理：\n"
                        + "      a) 当输入为中文药品名时，使用国际通用英文名称及首字母缩写\n"
                        + "         （例：'苯磺酸氨氯地平'对应'Amlodipine Besylate'和'AB'）\n"
                        + "      b) 当输入为英文药品名时，补充国际通用中文译名及完整拼写\n"
                        + "         （例：'Enalapril'需同时匹配'依那普利'和'Enalapril Maleate'）\n"
                        + "      c) 疾病名称需双向匹配ICD-11编码、SNOMED-CT术语及常见别名\n"
                        + "         （例：'心衰'需匹配'Heart Failure','HF','心力衰竭'）\n"
                        + "   - 动态匹配逻辑：\n"
                        + "      a) 当药品名称非空时：\n"
                        + "         - 所有药品的中英文及缩写必须共现于同一适应症描述\n"
                        + "         - 联用表述需同时满足药物组合形式（如'X+Y'或'X联合Y'）\n"
                        + "      b) 当药品名称为空时：\n"
                        + "         - 只需疾病列表中的名称在适应症文本中完整匹配\n"
                        + "      c) 当疾病列表包含多病时：\n"
                        + "         - 所有疾病术语（含ICD编码/别名）需共现于同一适应症\n"
                        + "         - 需存在合并治疗表述（如'治疗...合并症','combination therapy'）\n"
                        + "   - 安全性过滤：\n"
                        + "      a) 排除适应症前后存在否定性限定（not/除外/contraindicated）\n"
                        + "      b) 标注为加速批准(accelerated approval)视为未批准\n"
                        + "      c) 适应症必须明确列示于INDICATIONS AND USAGE章节\n"
                        + "3. 输出规范：\n"
                        + "   - 严格使用JSON格式，仅包含result字段\n"
                        + "   - result为布尔值：true=疾病明确获得批准，false=未批准\n"
                        + "   - 禁止任何额外文本或错误说明\n"
                        + "4. 输入数据：\n"
                        + "   - 药品名称：{{" + finalFirstDrugWord3 + "}}\n"
                        + "   - 疾病名称：{{" + diseaseAndNotStr + "}}\n"
                        + "   - PMDA说明书适应症内容：{{" + instruction_pmda + "}}\n"
                        + "请严格按此结构输出：\n"
                        + "{\"result\": false}\n"
                        + "注意：任何不符合要求的格式都将导致解析失败";

                try {
                    Date oneDate = new Date();
                    String pmda = "";

                    // gpt-4o-2024-11-20
                    JSONObject aiResult = retryUtils.executeWithRetry(fdaJudgePrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "pmda适应症是否获批", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiResult)) {
                        pmda = aiResult.getString("result");
                    }
                    if (StringUtils.isNotBlank(pmda) && "true".equals(pmda)) {
                        isApproved = true;
                        result.put("pmda", true);
                        indicationPmda = indicationPmda.replaceAll("未批准", "已批准");
                    }
                    long processingTime = new Date().getTime() - oneDate.getTime();
                    log.info("说明书日本 PMDA 适应证总结完成，花费时间{}ms", processingTime);
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            } else {
                BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);
                instructionQuery.must().add(QueryBuilders.termQuery("source", "fda"));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
                nativeSearchQuery.setMaxResults(20);

                SearchHits<InstructionIndex> searchHits = null;
                try {
                    searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class);
                    instruction_pmda  = searchHits.stream().map(SearchHit::getContent).map(InstructionIndex::getIndication).collect(Collectors.joining(";"));
                } catch (Exception e) {
                    log.error("PMDA查询错误: {}", e.getMessage(), e);
                }
            }

            // 生成最终的FDA适应症信息
            if (StringUtils.isNotBlank(instruction_pmda)) {
                StringBuilder builder = new StringBuilder(indicationPmda).append("\n");

                String summaryPrompt = "你是一位专业的医学翻译专家，请按以下步骤处理文本：\n"
                        + "1. 先对提供的说明书内容进行专业总结（不要遗漏剂量和人群信息）\n"
                        + "2. 然后将总结内容，保持跟原语言一致。\n"
                        + "3. 返回格式要求：\n"
                        + "```json\n"
                        + "{\n"
                        + "  \"original\": \"[保持跟原语言一致的总结内容]\",\n"
                        + "  \"translated\": \"[包含专业术语的中文翻译]\"\n"
                        + "}\n"
                        + "```\n"
                        + "严格要求：\n"
                        + "- 必须使用医学专业术语\n"
                        + "- 保留所有数字、剂量和专业术语原文\n"
                        + "- 不添加任何额外信息\n"
                        + "- 忠实于原文的临床意义\n"
                        + "4. 请只返回JSON格式数据体。\n"
                        + "输入文本：{{" + instruction_pmda + "}}\n";

                try {
                    // gpt-4o-2024-11-20
                    JSONObject aiSummaryResult = retryUtils.executeWithRetry(summaryPrompt, Constants.QWEN3_MAX_600_PRM, JSONObject.class, "fda适应症总结", PriorityConstants.PRIORITY_NORMAL, true);
                    if (Objects.nonNull(aiSummaryResult)) {
                        String original = aiSummaryResult.getString("original");
                        if (StringUtils.isNotBlank(original)) {
                            original = original.replaceAll("\n", "");
                            builder.append("适应症：\n").append(original).append("\n");
                        }

                        String translated = aiSummaryResult.getString("translated");
                        if (StringUtils.isNotBlank(translated)) {
                            translated = translated.replaceAll("\n", "");
                            builder.append("译文：\n").append(translated);
                        }
                    }
                    indicationPmda = builder.toString();
                } catch (Exception e) {
                    log.error("生成FDA适应症总结时发生错误: {}", e.getMessage(), e);
                }
            } else {
                String extraInfo = "暂未查询到 PMDA 关于" + finalFirstDrugWord + "的适应症信息";
                indicationPmda = indicationPmda + "\n" + extraInfo;
            }

            data.put("indicationPmda", indicationPmda);
            if (isApproved) {
                map.put(4, "PMDA-" + finalFirstDrugWord);
            }
        }, reportExecutor);


        // 等待所有任务完成
        try {
            CompletableFuture.allOf(indicationCom, fdaCom, emaCom, pmdaCom).join();
            log.info("多线程 说明书部分完成");
        } catch (Exception e) {
            log.error("任务执行异常", e);
        }

        // 所有线程完成后，统一处理引用编号
        if (MapUtils.isNotEmpty(map)) {
            JSONArray instructions = new JSONArray();
            Map<Integer, String> sortedMap = map.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .collect(Collectors.toMap(
                            Map.Entry::getKey,
                            Map.Entry::getValue,
                            (e1, e2) -> e1,
                            LinkedHashMap::new
                    ));

            // 为每个key分配引用编号
            for (Map.Entry<Integer, String> entry : sortedMap.entrySet()) {
                String value = entry.getValue();
                String reference = "[" + referenceCount + "] " + value;
                instructions.add(reference);
                
                if (value.contains("FDA")) {
                    String indicationFda = data.getString("indicationFda");
                    data.put("indicationFda", indicationFda.replaceFirst("；", "<sup>[" + referenceCount + "]</sup>；"));
                }
                if (value.contains("PMDA")) {
                    String indicationPmda = data.getString("indicationPmda");
                    data.put("indicationPmda", indicationPmda.replaceFirst("；", "<sup>[" + referenceCount + "]</sup>；"));
                }
                if (value.contains("EMA")) {
                    String indicationEma = data.getString("indicationEma");
                    data.put("indicationEma", indicationEma.replaceFirst("；", "<sup>[" + referenceCount + "]</sup>；"));
                }
                if (value.contains("NMPA")) {
                    String indicationEma = data.getString("indication");
                    data.put("indication", indicationEma.replaceFirst("：", "<sup>[" + referenceCount + "]</sup>："));
                }
                referenceCount++;
            }

            // 参考文献
            result.put("instructions", instructions);
            result.put("referenceCount", referenceCount);
        } 
    }

    /**
     *  指南 & 文献
     */
    private void effective(Condition condition, JSONObject result, JSONObject data, Long userId, int referenceCount) {
        Date oneDate = new Date();
        
        JSONArray guideInfo = new JSONArray();
        JSONObject literature = new JSONObject();

        AtomicInteger metaSize = new AtomicInteger(0);
        AtomicInteger rctSize = new AtomicInteger(0);
        AtomicInteger qSize = new AtomicInteger(0);
        AtomicInteger clinicSize = new AtomicInteger(0);
        AtomicInteger reviewSize = new AtomicInteger(0);
        AtomicInteger ccSize = new AtomicInteger(0);
        AtomicInteger cSectionSize = new AtomicInteger(0);
        AtomicInteger csSize = new AtomicInteger(0);
        AtomicInteger crSize = new AtomicInteger(0);
        AtomicInteger optionSize = new AtomicInteger(0);
        AtomicInteger aeSize = new AtomicInteger(0);
        AtomicInteger vtSize = new AtomicInteger(0);
        AtomicInteger guideSize = new AtomicInteger(0);

        List<String> references = new ArrayList<>();
        List<JSONObject> paperInfo = new ArrayList<>();
        List<String> duplicateGuide = new ArrayList<>();
        List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(Query.query(Criteria.where("conditionId").is(condition.getId()).and("status").is(1).and("userId").is(userId)), GuideIncludeOrExclude.class);

        Set<String> includeGuideIds = guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).collect(Collectors.toSet());

        long guideIncludeCount = includeGuideIds.size();
        // 总结使用
        result.put("guideIncludeCount", guideIncludeCount);
        // 前面的序号
        int guideCount = 1;

        JSONObject paperEffectSummary = new JSONObject();

        LiteratureGuideVo literatureGuide = mongoTemplate.findOne(new Query(Criteria.where("_id").is(condition.getId())), LiteratureGuideVo.class, "evaluation_literatureGuideConfirm");
        
        if (literatureGuide != null) {
            List<GuideConfirmVo> guideConfirmVo = literatureGuide.getGuideConfirmVo();
            for (GuideConfirmVo confirmVo : guideConfirmVo) {
                JSONObject inner = new JSONObject();
                BoolQueryBuilder guideSearchBool = new BoolQueryBuilder();
                guideSearchBool.must().add(QueryBuilders.idsQuery().addIds(confirmVo.getId()));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideSearchBool);
                SearchHit<GuideIndex> guideIndex = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
                if (Objects.nonNull(guideIndex)) {
                    GuideIndex guide = guideIndex.getContent();
                    includeGuideIds.remove(guide.getId());
                    String title = guide.getTitle();
                    if (StrUtil.isBlank(title)) {
                        continue;
                    }
                    if (!guideConfirmVo.isEmpty() && guideConfirmVo.size() != 1) {
                        inner.put("title", "（"+ guideCount++ +"）"  + "《" + title + "》 <sup>["+ referenceCount +"]</sup>：");
                    } else {
                        inner.put("title", "《" + title + "》 <sup>["+ referenceCount +"]</sup>：");
                    }

                    // 编辑参考文献
                    String guideNumber = "[" + referenceCount + "]";
                    // 制定者
                    String zdz = guide.getZdz();
                    if (StringUtils.isNotBlank(zdz)) {
                        guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                    }
                    guideNumber += title + "[J].";
                    String cc = guide.getCc();
                    if (StringUtils.isNotBlank(cc)) {
                        guideNumber += cc + ".";
                    }
                    String ysar = guide.getYsar();
                    if (StringUtils.isNotBlank(ysar)) {
                        guideNumber += ysar + ".";
                    }
                    // 这里是在拼指南
                    duplicateGuide.add(guideNumber);

                    String blocks = confirmVo.getBlocks();
                    if (StringUtils.isNotBlank(blocks)) {
                        inner.put("data", blocks);
                    }
                    guideInfo.add(inner);
                    referenceCount++;
                }
            }
        }

        if (!includeGuideIds.isEmpty()) {
            Date concurrenceData = new Date();
            List<CompletableFuture<Boolean>> futures = new ArrayList<>();
            AtomicInteger guideICount = new AtomicInteger(guideCount);
            AtomicInteger paperICount = new AtomicInteger(referenceCount);

            for (String includeGuideId : includeGuideIds) {
                CompletableFuture<Boolean> guideSummaryFuture = CompletableFuture.supplyAsync(() -> {
                    try {
                        // 原有的业务逻辑
                        TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("guideId", includeGuideId);
                        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(termQueryBuilder);
                        nativeSearchQuery.setMaxResults(10);
                        SearchHits<GuideBlockIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideBlockIndex.class);
                        String guideBlockContent = search.getSearchHits().stream()
                                .map(SearchHit::getContent)
                                .map(GuideBlockIndex::getBlock)
                                .collect(Collectors.joining(";"));

                        String summaryContent = "";
                        if (StringUtils.isNotBlank(guideBlockContent)) {
                            String question_1 = String.format("请作为专业医学内容分析师，对以下医学资料进行深度总结分析。\n" +
                                    "\n" +
                                    "总结要求：\n" +
                                    "1. 提取核心医学概念和关键诊疗信息\n" +
                                    "2. 保持医学术语准确性，确保专业表达\n" +
                                    "3. 突出临床实用价值，自动忽略重复、版权声明、版本标识等非实质性冗余内容\n" +
                                    "4. 形成条理清晰、结构化的总结\n" +
                                    "5. 对重要临床建议或更新要点进行适当强调\n" +
                                    "\n" +
                                    "输出格式要求：\n" +
                                    "- 直接返回String类型纯文本内容。\n" +
                                    "- 不使用任何markdown格式标签。\n" +
                                    "- 使用普通文本的换行和分段组织内容\n" +
                                    "- 采用简洁、精准的中文表达\n" +
                                    "\n" +
                                    "医学资料：\n" +
                                    "%s\n" +
                                    "\n" +
                                    "请返回纯文本格式总结内容：\n",  guideBlockContent);

                            summaryContent = retryUtils.executeWithRetryOld(question_1, Constants.QWEN3_MAX_2025_09_23_60_PRM, String.class, "手动指南文本块总结", PriorityConstants.PRIORITY_HIGH);
                            summaryContent = summaryContent.replaceAll("\\*", " ");
                        }

                        IdsQueryBuilder idsQueryBuilder = QueryBuilders.idsQuery().addIds(includeGuideId);
                        NativeSearchQuery searchGuideNativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
                        SearchHit<GuideIndex> guideIndex = elasticsearchRestTemplate.searchOne(searchGuideNativeSearchQuery, GuideIndex.class);

                        synchronized (guideInfo) { 
                            if (guideIndex != null) {
                                JSONObject inner = new JSONObject();
                                GuideIndex guide = guideIndex.getContent();
                                String title = guide.getTitle();

                                if (includeGuideIds.size() != 1) {
                                    inner.put("title", "（"+ guideICount.getAndIncrement() +"）" + "《" + title + "》 <sup>["+ paperICount.get() +"]</sup>：");
                                } else {
                                    inner.put("title", "《" + title + "》 <sup>["+ paperICount.get() +"]</sup>：");
                                }

                                String guideNumber = "[" + paperICount.get() + "]";
                                String zdz = guide.getZdz();
                                if (StringUtils.isNotBlank(zdz)) {
                                    guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                                }
                                guideNumber += title + "[J].";

                                String cc = guide.getCc();
                                if (StringUtils.isNotBlank(cc)) {
                                    guideNumber += cc + ".";
                                }
                                String ysar = guide.getYsar();
                                if (StringUtils.isNotBlank(ysar)) {
                                    guideNumber += ysar + ".";
                                }

                                synchronized (duplicateGuide) {
                                    duplicateGuide.add(guideNumber);
                                }

                                if (StringUtils.isNotBlank(summaryContent)) {
                                    inner.put("data", summaryContent);
                                }
                                guideInfo.add(inner);
                                paperICount.getAndIncrement();
                            }
                        }

                        return true;
                    } catch (Exception e) {
                        log.error("处理指南ID {} 时发生异常", includeGuideId, e);
                        return false;
                    }
                }, reportExecutor);

                futures.add(guideSummaryFuture);
            }

            // 等待所有任务完成
            try {
                CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
                log.info("报告所有模块完成，花费时间{}", new Date().getTime() - concurrenceData.getTime());
            } catch (Exception e) {
                log.error("任务执行异常", e);
            } finally {
                referenceCount = paperICount.get();
            }
        }

        List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(Query.query(Criteria.where("conditionId").is(condition.getId()).and("status").is(1).and("userId").is(userId)), PaperIncludeOrExclude.class);

        List<String> includePaperIds = paperIncludeOrExcludes.stream().map(PaperIncludeOrExclude::getPaperId).distinct().collect(Collectors.toList());

        if (literatureGuide != null || !includePaperIds.isEmpty()) {
            // 文献部分
            StringBuilder metaBuilder = new StringBuilder();
            StringBuilder rctBuilder = new StringBuilder();
            StringBuilder qBuilder = new StringBuilder();
            StringBuilder clinicBuilder = new StringBuilder();
            StringBuilder reviewBuilder = new StringBuilder();
            StringBuilder ccBuilder = new StringBuilder();
            StringBuilder cSectionBuilder = new StringBuilder();
            StringBuilder csBuilder = new StringBuilder();
            StringBuilder crBuilder = new StringBuilder();
            StringBuilder optionBuilder = new StringBuilder();
            StringBuilder aeBuilder = new StringBuilder();
            StringBuilder vtBuilder = new StringBuilder();
            StringBuilder guideBuilder = new StringBuilder();
            
            StringBuilder effectSummaryBuilder = new StringBuilder();

            AtomicInteger numbers = new AtomicInteger();

            // 系统评价/Meta分析、综述：（包括：系统评价/Meta分析、综述）
            literature.put("metaLiteratureDataTable", new JSONArray());
            // 临床试验：（包括：随机对照试验、临床试验）
            literature.put("testLiteratureDataTable", new JSONArray());
            // 队列研究
            literature.put("qLiteratureDataTable", new JSONArray());
            // 其他（包括：动物实验、体外实验、其他）
            literature.put("otherLiteratureDataTable", new JSONArray());

            List<String> conclusion = new ArrayList<>();

            List<String> defaultIds = new ArrayList<>();
            if (literatureGuide != null) {
                defaultIds = literatureGuide.getLiteratureConfirmVo().stream().map(LiteratureConfirmVo::getId).distinct().collect(Collectors.toList());
            }           

            @SuppressWarnings("unchecked")
            List<String> subIds = new ArrayList<>((Collection<String>) CollectionUtils.subtract(includePaperIds, defaultIds));

            data.put("literature", paperInfo);
            
            defaultIds.addAll(subIds);
            if (!defaultIds.isEmpty()) {

                List<CompletableFuture<Void>> futures = new ArrayList<>();

                AtomicInteger referCount = new AtomicInteger(referenceCount);

                ConcurrentHashMap<Integer, String> refMap = new ConcurrentHashMap<>();
                ConcurrentHashMap<Integer, JSONObject> paperEntityMap = new ConcurrentHashMap<>();
                
                for (String literature_id : defaultIds) {
                    CompletableFuture<Void> paperFuture = CompletableFuture.runAsync(() -> {
                        try {
                            MongoLiterature mongoLiterature = fineScreenFeign.paper(literature_id);
                            PdfEditResult paperEditResult = pdfEditResultService.getPaperEditResultPaperIdAndQuestionId(literature_id, condition.getId(), "0");

                            if (mongoLiterature == null || StrUtil.isBlank(mongoLiterature.getTitle())) {
                                return;
                            }

                            int refNum = referCount.getAndIncrement();

                            List<Integer> lastNewType = mongoLiterature.getLastNewType();
                            // 统一拼接内容格式字符串
                            String baseStr = "[" + refNum + "]"
                                    + "---标题：" + mongoLiterature.getTitle()
                                    + "---作者：" + mongoLiterature.getAuthor()
                                    + "---发布年份：" + mongoLiterature.getYear()
                                    + "---摘要：" + mongoLiterature.getSummary()
                                    + "\b";

                            if (lastNewType.contains(0)) {
                                metaSize.incrementAndGet();
                                metaBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(2)) {
                                rctSize.incrementAndGet();
                                rctBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(3)) {
                                qSize.incrementAndGet();
                                qBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(1)) {
                                reviewSize.incrementAndGet();
                                reviewBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(4)) {
                                ccSize.incrementAndGet();
                                ccBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(5)) {
                                cSectionSize.incrementAndGet();
                                cSectionBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(6)) {
                                csSize.incrementAndGet();
                                csBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(7)) {
                                crSize.incrementAndGet();
                                crBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(8)) {
                                optionSize.incrementAndGet();
                                optionBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(9)) {
                                aeSize.incrementAndGet();
                                aeBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(10)) {
                                vtSize.incrementAndGet();
                                vtBuilder.append(baseStr);
                            }
                            if (lastNewType.contains(11)) {
                                guideSize.incrementAndGet();
                                guideBuilder.append(baseStr);
                            }

                            List<Integer> type = mongoLiterature.getType();
                            if (CollectionUtils.isNotEmpty(type) && type.contains(7)) {
                                clinicSize.incrementAndGet();
                                clinicBuilder.append(baseStr);
                            }

                            buildPaper(paperInfo, mongoLiterature, numbers, refNum, references, literature, paperEditResult, refMap, paperEntityMap);
                            return;

                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                            return;
                        }
                    }, reportExecutor);
                    
                    futures.add(paperFuture);
                }

                // 等待所有任务完成
                try {
                    CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
                } catch (Exception e) {
                    log.error("任务执行异常", e);
                } finally {
                    List<String> sortedReferences = refMap.entrySet()
                            .stream()
                            .sorted(Map.Entry.comparingByKey())
                            .map(Map.Entry::getValue)
                            .collect(Collectors.toList());
                    references.addAll(sortedReferences);

                    List<JSONObject> sortedPaperEntity = paperEntityMap.entrySet()
                            .stream()
                            .sorted(Map.Entry.comparingByKey())
                            .map(Map.Entry::getValue)
                            .collect(Collectors.toList());
                    paperInfo.addAll(sortedPaperEntity);
                    data.put("literature", paperInfo);
                }
            }

            AtomicInteger[] sizes = {
                    metaSize,
                    rctSize,
                    qSize,
                    clinicSize,
                    reviewSize,
                    ccSize,
                    cSectionSize,
                    csSize,
                    crSize,
                    optionSize,
                    aeSize,
                    vtSize,
                    guideSize
            };

            for (int i = 0; i < sizes.length; i++) {
                int count = sizes[i].get();
                if (count > 0) {
                    conclusion.add(Constants.PAPER_TYPE_NAME[i] + count + "篇");
                }
            }
            
            String drugStr = condition.getDrugs().stream().filter(drug -> drug.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("、"));
            String diseaseStr = condition.getDiseases().stream().filter(disease -> disease.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("、"));

            // 使用重构后的方法
            CompletableFuture<JSONArray> metaFuture = processStudyType(
                    metaBuilder, metaSize.get(), "系统综述/Meta分析", "meta文献总结", drugStr, diseaseStr, reportExecutor, 1);

            CompletableFuture<JSONArray> rctFuture = processStudyType(
                    rctBuilder, rctSize.get(), "随机对照试验", "rct文献总结", drugStr, diseaseStr, reportExecutor, 1);

            CompletableFuture<JSONArray> qFuture = processStudyType(
                    qBuilder, qSize.get(), "队列研究", "队列文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> clinicFuture = processStudyType(
                    clinicBuilder, clinicSize.get(), "临床研究", "临床研究文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> reviewFuture = processStudyType(
                    reviewBuilder, reviewSize.get(), "传统综述", "传统综述文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> ccFuture = processStudyType(
                    ccBuilder, ccSize.get(), "病例对照研究", "病例对照研究文献总结", drugStr, diseaseStr, reportExecutor, 2);


            CompletableFuture<JSONArray> cSectionFuture = processStudyType(
                    cSectionBuilder, cSectionSize.get(), "横断面研究", "横断面研究文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> csFuture = processStudyType(
                    csBuilder, csSize.get(), "病例系列", "病例系列文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> crFuture = processStudyType(
                    crBuilder, crSize.get(), "病例报告", "病例报告文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> optionFuture = processStudyType(
                    optionBuilder, optionSize.get(), "专家意见和评论", "专家意见和评论文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> aeFuture = processStudyType(
                    aeBuilder, aeSize.get(), "动物实验", "动物实验文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> vtFuture = processStudyType(
                    vtBuilder, vtSize.get(), "体外试验", "体外试验文献总结", drugStr, diseaseStr, reportExecutor, 2);

            CompletableFuture<JSONArray> guideFuture = processStudyType(
                    guideBuilder, guideSize.get(), "指南/专家共识", "指南/专家共识文献总结", drugStr, diseaseStr, reportExecutor, 2);


            CompletableFuture<String> summaryFuture = CompletableFuture.supplyAsync(() -> {
                BoolQueryBuilder paperQuery = new BoolQueryBuilder();

                // 过滤没有title的文献
                paperQuery.must().add(QueryBuilders.existsQuery("title"));

                // 年份
                String literatureStartYear = condition.getLiteratureStartYear();
                String literatureEndYear = condition.getLiteratureEndYear();
                RangeQueryBuilder ysarRangeQueryBuilder = QueryBuilders.rangeQuery("year");
                if (StringUtils.isNotBlank(literatureStartYear)) {
                    ysarRangeQueryBuilder.gte(literatureStartYear);
                }
                if (StringUtils.isNotBlank(literatureEndYear)) {
                    ysarRangeQueryBuilder.lte(literatureEndYear);
                }
                paperQuery.must().add(ysarRangeQueryBuilder);


                // 研究类型
                List<Integer> studyType = condition.getStudyType();
                BoolQueryBuilder studyTypeBool = new BoolQueryBuilder();
                if (CollectionUtils.isNotEmpty(studyType)) {
                    for (Integer type : studyType) {
                        if (type == 14) {
                            studyTypeBool.should().add(QueryBuilders.termQuery("type", 7));
                        } else {
                            studyTypeBool.should().add(QueryBuilders.termQuery("lastNewType", type));
                        }
                    }
                } else {
                    studyTypeBool.should().add(QueryBuilders.termsQuery("lastNewType", Constants.PAPER_LIST_LITERATURE_TYPE));
                    studyTypeBool.should().add(QueryBuilders.matchQuery("type", 7));
                }

                // 期刊
                List<String> zhJournal = condition.getZhJournal();
                List<String> enJournal = condition.getEnJournal();
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                if (CollectionUtils.isNotEmpty(zhJournal) && zhJournal.size() < 4) {
                    BoolQueryBuilder zhBoolQueryBuilder = QueryBuilders.boolQuery();
                    zhBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "zh"));
                    for (String journal : zhJournal) {
                        switch (journal) {
                            case "北大核心":
                                journal = "Peking University";
                                break;
                            case "科技核心":
                                journal = "Technology";
                                break;
                            case "南大核心":
                                journal = "Nanjing University";
                                break;
                            case "CSCD":
                                journal = "CSCD";
                                break;
                            default:
                                break;
                        }
                        TermQueryBuilder termQuery = QueryBuilders.termQuery("journalDivision.keyword", journal);
                        zhBoolQueryBuilder.should().add(termQuery);
                    }
                    boolQueryBuilder.should().add(zhBoolQueryBuilder);
                } else {
                    boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "zh"));
                }

                if (CollectionUtils.isNotEmpty(enJournal) && enJournal.size() < 5) {
                    BoolQueryBuilder enBoolQueryBuilder = QueryBuilders.boolQuery();
                    enBoolQueryBuilder.must().add(QueryBuilders.termQuery("language", "en"));
                    List<String> levelList = enJournal.stream().map(str -> {
                        int left = str.indexOf("Q");
                        int right = str.indexOf(")");
                        return str.substring(left + 1, right);
                    }).sorted().collect(Collectors.toList());

                    String highLevel = levelList.get(0);
                    for (String level : levelList) {
                        if ("5".equals(level)) {
                            level = "N/A";
                        } else {
                            level = "Q" + level;
                        }
                        MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + level + ")");
                        MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + level + ")");
                        MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + level + ")");
                        enBoolQueryBuilder.should().add(scie);
                        enBoolQueryBuilder.should().add(esci);
                        enBoolQueryBuilder.should().add(ssci);
                        enBoolQueryBuilder.should().add(ahci);
                    }
                    for (int i = Integer.parseInt(highLevel) - 1; i > 0; i--) {
                        MatchPhraseQueryBuilder scie = QueryBuilders.matchPhraseQuery("journalDivision", "SCIE(Q" + i + ")");
                        MatchPhraseQueryBuilder esci = QueryBuilders.matchPhraseQuery("journalDivision", "ESCI(Q" + i + ")");
                        MatchPhraseQueryBuilder ssci = QueryBuilders.matchPhraseQuery("journalDivision", "SSCI(Q" + i + ")");
                        MatchPhraseQueryBuilder ahci = QueryBuilders.matchPhraseQuery("journalDivision", "AHCI(Q" + i + ")");
                        enBoolQueryBuilder.should().add(scie);
                        enBoolQueryBuilder.should().add(esci);
                        enBoolQueryBuilder.should().add(ssci);
                        enBoolQueryBuilder.should().add(ahci);
                    }
                    boolQueryBuilder.should().add(enBoolQueryBuilder);
                } else {
                    boolQueryBuilder.should().add(QueryBuilders.termQuery("language", "en"));
                }
                paperQuery.must().add(boolQueryBuilder);

                paperQuery.must().add(QueryUtils.createPaperQueryNew(condition, 1));
                paperQuery.filter().add(QueryBuilders.termsQuery("isIncomplete", "0", "2"));

                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(paperQuery);
                long count = elasticsearchRestTemplate.count(nativeSearchQuery, PaperIndex.class);

                String statistics = "检索EviMed近20年文献数据库";
                // 有纳入文献
                if (count > 0) {
                    nativeSearchQuery.addAggregation(AggregationBuilders.sum("dupNumCount").field("dupNum"));
                    SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
                    Aggregations aggregations = search.getAggregations();
                    long dupNum = 0L;
                    if (Objects.nonNull(aggregations)) {
                        try {
                            ParsedSum dupNumCount = aggregations.get("dupNumCount");
                            double value = dupNumCount.getValue();
                            dupNum += (long) value;
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                        }
                    }
                    long total = count + dupNum;

                    statistics += "，初检获文献" + total + "篇，剔除重复及残缺文献后余" + dupNum + "篇。";
                    if (CollectionUtils.isNotEmpty(conclusion)) {
                        statistics += "最终纳入" + String.join("，", conclusion) + "，具体的文献特征详见附录。";
                    }
                } else {
                    statistics += "初检获文献0篇。";
                }
                return statistics;
            }, reportExecutor);

            // 等待所有任务完成
            CompletableFuture<Void> allFutures = CompletableFuture.allOf(summaryFuture, metaFuture, rctFuture, qFuture, clinicFuture, reviewFuture, ccFuture, cSectionFuture, csFuture, crFuture, optionFuture, aeFuture, vtFuture, guideFuture);
            allFutures.join();

            try {
                paperEffectSummary.put("summaryTitle", "<b>3.1 文献检索结果</b>");
                String summary = summaryFuture.get();
                paperEffectSummary.put("summary", summary);

                paperEffectSummary.put("paperTitle", "<b>3.2 纳入文献基本情况：</b>");

                JSONArray paperCon = new JSONArray();
                Stream.of(metaFuture, rctFuture, qFuture, clinicFuture, reviewFuture,
                                ccFuture, cSectionFuture, csFuture, crFuture, optionFuture,
                                aeFuture, vtFuture, guideFuture)
                        .map(future -> {
                            try {
                                return future.get();
                            } catch (Exception e) {
                                log.error("获取Future结果失败", e);
                                return new JSONArray();
                            }
                        })
                        .filter(CollectionUtils::isNotEmpty)
                        .forEach(paperCon::add);

                paperEffectSummary.put("paperCon", paperCon);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }

        result.put("metaIncludeCount", metaSize);
        result.put("rctIncludeCount", rctSize);
        result.put("qIncludeCount", qSize);
        result.put("clinicIncludeCount", clinicSize);
        result.put("reviewIncludeCount", reviewSize);
        result.put("ccIncludeCount", ccSize);
        result.put("cSectionIncludeCount", cSectionSize);
        result.put("csIncludeCount", csSize);
        result.put("crIncludeCount", crSize);
        result.put("optionIncludeCount", optionSize);
        result.put("aeIncludeCount", aeSize);
        result.put("vtIncludeCount", vtSize);
        result.put("guidePaperIncludeCount", guideSize);
        result.put("references", references);
        
        log.info("指南 文献 模块完成，花费时间{}", new Date().getTime() - oneDate.getTime());
        result.put("duplicateGuide", duplicateGuide);
        result.put("referenceCount", referenceCount);

        data.put("guide", guideInfo);
        
        data.put("paperEffectSummary", paperEffectSummary);

//        data.put("literature", literature);
    }
    // 通用处理方法
    private CompletableFuture<JSONArray> processStudyType(
            StringBuilder builder, int size, String displayName, String logName,
            String drugStr, String diseaseStr, Executor executor, int promptType) {

        return CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isBlank(builder)) {
                return new JSONArray();
            }

            String prompt;
            switch (promptType) {
                case 2:
                    prompt = PromptConstant.getPrompt(PromptConstant.EFFECT_OTHER, drugStr, diseaseStr, builder);
                    break;
                default:
                    prompt = PromptConstant.getPrompt(PromptConstant.EFFECT, drugStr, diseaseStr, builder);
                    break;
            }
            JSONArray conArray = new JSONArray();
            conArray.add("<b>" + displayName + "：共纳入" + size + "篇" + getStudyTypeName(displayName) + "。</b>");

            JSONObject aiResult = retryUtils.executeWithRetryOld(prompt, Constants.QWEN3_MAX_2025_09_23_60_PRM, JSONObject.class, logName, PriorityConstants.PRIORITY_HIGH);

            JSONArray separateSummary = aiResult.getJSONArray("separate_summary");
            separateSummary.forEach(o ->
                    conArray.add(formatSummaryText(JSON.parseObject(JSON.toJSONString(o), String.class)))
            );

            return conArray;
        }, executor);
    }

    // 提取文本格式化逻辑
    private String formatSummaryText(String text) {
        return text.replaceAll("\n", "")
                .replaceAll("\\[", "<sup>[")
                .replaceAll("]", "]</sup>");
    }

    // 获取研究类型名称（处理Meta分析的特殊情况）
    private String getStudyTypeName(String displayName) {
        return displayName.contains("Meta") ? "Meta分析" : displayName;
    }

    private void buildPaper(List<JSONObject> paperInfo, MongoLiterature mongoLiterature, AtomicInteger numbers, int referenceCount, List<String> references, JSONObject literature, PdfEditResult paperEditResult, ConcurrentHashMap<Integer, String> refMap, ConcurrentHashMap<Integer, JSONObject> paperEntityMap) {

        JSONObject paper = new JSONObject();
        
        paper.put("number", numbers.incrementAndGet());
        
        List<String> authorList = mongoLiterature.getAuthor();
        // 作者
        String author = "";
        if (CollectionUtils.isNotEmpty(authorList)) {
            author = authorList.get(0);
        }
        // 发表年份
        String year = "";
        if (StringUtils.isNotBlank(mongoLiterature.getYear())) {
            year = mongoLiterature.getYear();
        }
        paper.put("year", year);
        // 来源
        String source = author + "<sup>[" + referenceCount + "]</sup>";
        paper.put("source", source);

        String reference = buildReference(mongoLiterature);
        reference = "[" + referenceCount + "] " + reference;
//        references.add(reference);
        refMap.put(referenceCount, reference);

        // 研究类型
        StringBuilder studyTypeBuilder = new StringBuilder();
        if (CollectionUtils.isNotEmpty(mongoLiterature.getLastNewType())) {
            for (Integer type : mongoLiterature.getLastNewType()) {
                switch (type) {
                    case 0:
                        studyTypeBuilder.append("系统综述/Meta分析、");
                        assembleLiterature("meta", literature, mongoLiterature);
                        continue;
                    case 1:
                        studyTypeBuilder.append("传统综述、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 2:
                        studyTypeBuilder.append("随机对照试验、");
                        assembleLiterature("test", literature, mongoLiterature);
                        continue;
                    case 3:
                        studyTypeBuilder.append("队列研究、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 4:
                        studyTypeBuilder.append("病例对照研究、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 5:
                        studyTypeBuilder.append("横断面研究、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 6:
                        studyTypeBuilder.append("病例系列、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 7:
                        studyTypeBuilder.append("病例报告、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 8:
                        studyTypeBuilder.append("专家意见和评价、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 9:
                        studyTypeBuilder.append("动物实验、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 10:
                        studyTypeBuilder.append("体外实验、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 11:
                        studyTypeBuilder.append("指南/共识、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 12:
                        studyTypeBuilder.append("经济学研究、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 13:
                        studyTypeBuilder.append("其他、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    case 14:
                        studyTypeBuilder.append("临床试验、");
                        assembleOtherLiterature("other", literature, mongoLiterature);
                        continue;
                    default:
                        break;
                }
            }
            if (CollectionUtils.isNotEmpty(mongoLiterature.getType())) {
                for (Integer type : mongoLiterature.getType()) {
                    if (type == 7) {
                        studyTypeBuilder.append("临床试验、");
                        assembleLiterature("test", literature, mongoLiterature);
                    }
                }
            }
        } else {
            studyTypeBuilder.append(" ");
        }
        // 研究类型
        String studyTypeName = studyTypeBuilder.toString();
        if (StringUtils.isNotBlank(studyTypeName)) {
            studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
        }
        paper.put("studyType", studyTypeName);

        // 研究疾病
        String studyDiseaseName = "-";
        List<String> p = mongoLiterature.getP();
        if (CollUtil.isNotEmpty(p)) {
            studyDiseaseName = String.join("、", p);
        }

        // 实验组干预指标
        String ic_str = "-";
        List<String> ic = mongoLiterature.getIc();
        if (CollUtil.isNotEmpty(ic)) {
            ic_str = String.join("、", ic);
        }

        // 结局指标
        String index = "-";
        if (CollUtil.isNotEmpty(mongoLiterature.getO())) {
            index = String.join("、", mongoLiterature.getO());
        }

        String summary = mongoLiterature.getSummary();
        if (studyDiseaseName.equals("-") && ic_str.equals("-") && index.equals("-") && StringUtils.isNotBlank(summary)) {
            JSONObject pico = retryUtils.executeWithRetryOld(PromptConstant.getPrompt(PromptConstant.LITERATURE_INFO_EXTRACT, summary), Constants.QWEN3_MAX_2025_09_23_60_PRM, JSONObject.class, "文献信息提取", PriorityConstants.PRIORITY_HIGH);
            studyDiseaseName = pico.getString("disease");
            String iStr = pico.getString("intervention_measures");
            String cStr = pico.getString("control_measures");
            ic_str = iStr + "/" + cStr;
            index = pico.getString("outcome_indicators");
        }
        paper.put("studyDiseaseName", studyDiseaseName);
        paper.put("ic", ic_str);
        paper.put("index", index);

        // 结论
        String conclusion = "-";
        if (StringUtils.isNotBlank(mongoLiterature.getConclusion())) {
            conclusion = mongoLiterature.getConclusion();
        }
        // 暂时这么多 依次添加 如果在多表头 封装一下方法
        conclusion = conclusion.replaceFirst("结论：", "");
        conclusion = conclusion.replaceFirst("结论:", "");
        conclusion = conclusion.replaceFirst("结论", "");
        conclusion = conclusion.replaceFirst("CONCLUSION：", "");
        conclusion = conclusion.replaceFirst("CONCLUSION:", "");
        conclusion = conclusion.replaceFirst("CONCLUSION", "");
        conclusion = conclusion.replaceFirst("CONCLUSIONS：", "");
        conclusion = conclusion.replaceFirst("CONCLUSIONS:", "");
        conclusion = conclusion.replaceFirst("CONCLUSIONS", "");
        conclusion = conclusion.replaceFirst("Conclusions：", "");
        conclusion = conclusion.replaceFirst("Conclusions:", "");
        conclusion = conclusion.replaceFirst("Conclusions", "");
        conclusion = conclusion.replaceFirst("Conclusion：", "");
        conclusion = conclusion.replaceFirst("Conclusion:", "");
        conclusion = conclusion.replaceFirst("Conclusion", "");
        paper.put("conclusion", conclusion);

        // 影响因子
        String jcr = "-";
        if (Objects.nonNull(mongoLiterature.getJcr())) {
            jcr = String.valueOf(mongoLiterature.getJcr());
        }
        paper.put("jcr", jcr);

        // 核心期刊
        String kernelJournal = "-";
        String language = mongoLiterature.getLanguage();
        if ("zh".equals(language)) {
            List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
            StringBuilder zhKernelJournalBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(recognizedKernelJournals)) {
                for (String recognizedKernelJournal : recognizedKernelJournals) {
                    switch (recognizedKernelJournal) {
                        case "Technology":
                            zhKernelJournalBuilder.append("科技核心、");
                            break;
                        case "Peking University":
                            zhKernelJournalBuilder.append("北大核心、");
                            break;
                        case "Nanjing University":
                            zhKernelJournalBuilder.append("南大核心、");
                        case "CSCD":
                            zhKernelJournalBuilder.append("CSCD、");
                            break;
                        default:
                            break;
                    }
                }
            }
            if (StringUtils.isNotBlank(zhKernelJournalBuilder)) {
                kernelJournal = zhKernelJournalBuilder.substring(0, zhKernelJournalBuilder.length() - 1);
            }
        } else {
            List<String> journalDivision = mongoLiterature.getJournalDivision();
            List<String> enKernelJournalList = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(journalDivision)) {
                for (String s : journalDivision) {
                    if (s.contains("-")) {
                        String[] split = Arrays.stream(s.split("-")).distinct().toArray(String[]::new);
                        if (split.length > 1) {
                            String level = s.split("-")[1];
                            if (level.contains("(")) {
                                level = level.substring(level.indexOf("("), level.indexOf(")") + 1);
                                enKernelJournalList.add("JCR" + level);
                            }
                        }
                    }
                }
            }
            if (CollectionUtils.isNotEmpty(enKernelJournalList)) {
                List<String> level = new ArrayList<>();
                enKernelJournalList.stream().distinct().forEach(item -> {
                    if (item.contains("(")) {
                        if (item.contains("N/A")) {
                            level.add("5");
                        } else {
                            level.add(item.substring(item.indexOf("Q") + 1, item.indexOf(")")));
                        }
                    }
                });
                List<String> levelSort = level.stream().sorted(Comparator.comparing(String::toString, Comparator.reverseOrder())).collect(Collectors.toList());
                String highLevel = levelSort.get(0);
                if (Objects.equals(highLevel, "5")) {
                    kernelJournal = "JCR (N/A)";
                } else {
                    kernelJournal = "JCR (Q"+ highLevel +")";
                }
            }
        }
        paper.put("kernelJournal", kernelJournal);

        paper.put("qualityMeta", "-");
        if (Objects.nonNull(paperEditResult)) {
            String qualityMeta = paperEditResult.getQualityMeta();
            paper.put("qualityMeta", qualityMeta);
        }

//        paperInfo.add(paper);
        paperEntityMap.put(referenceCount, paper);
    }


    private void assembleLiterature(String typeName, JSONObject literature, MongoLiterature mongoLiterature) {
        JSONObject innerObj = new JSONObject();
        
        String reference = buildReference(mongoLiterature);
        innerObj.put("reference", reference);
        
        String summary = mongoLiterature.getSummary();
        innerObj.put("summary", summary);
        innerObj.put("quality", "目前是默认固定值 AMSTAR 质量评分：XX");

        // 影响因子
        String jcr = "-";
        if (Objects.nonNull(mongoLiterature.getJcr())) {
            jcr = String.valueOf(mongoLiterature.getJcr());
        }
        //  ++++++
        // 核心期刊
        String kernelJournal = "-";
        String language = mongoLiterature.getLanguage();
        if ("zh".equals(language)) {
            List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
            StringBuilder zhKernelJournalBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(recognizedKernelJournals)) {
                for (String recognizedKernelJournal : recognizedKernelJournals) {
                    switch (recognizedKernelJournal){
                        case "Technology":
                            zhKernelJournalBuilder.append("科技核心、");
                            break;
                        case "Peking University":
                            zhKernelJournalBuilder.append("北大核心、");
                            break;
                        case "Nanjing University":
                            zhKernelJournalBuilder.append("南大核心、");
                        case "CSCD":
                            zhKernelJournalBuilder.append("CSCD、");
                            break;
                        default:
                            break;
                    }
                }
            }
            if (StringUtils.isNotBlank(zhKernelJournalBuilder)) {
                kernelJournal = zhKernelJournalBuilder.substring(0, zhKernelJournalBuilder.length() - 1);
            }
        } else {
            List<String> journalDivision = mongoLiterature.getJournalDivision();
            List<String> enKernelJournalList = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(journalDivision)) {
                for (String s : journalDivision) {
                    if (s.contains("-")) {
                        String[] split = Arrays.stream(s.split("-")).distinct().toArray(String[]::new);
                        if (split.length > 1) {
                            String level = s.split("-")[1];
                            level = level.substring(level.indexOf("("), level.indexOf(")") + 1);
                            enKernelJournalList.add("JCR" + level);
                        }
                    }
                }
            }
            if (CollectionUtils.isNotEmpty(enKernelJournalList)) {
                List<String> level = new ArrayList<>();
                enKernelJournalList.stream().distinct().forEach(item -> {
                    if (item.contains("(")) {
                        if (item.contains("N/A")) {
                            level.add("5");
                        } else {
                            level.add(item.substring(item.indexOf("Q") + 1, item.indexOf(")")));
                        }
                    }
                });
                List<String> levelSort = level.stream().sorted(Comparator.comparing(String::toString, Comparator.reverseOrder())).collect(Collectors.toList());
                String highLevel = levelSort.get(0);
                if (Objects.equals(highLevel, "5")) {
                    kernelJournal = "JCR (N/A)";
//                            kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
                } else {
                    kernelJournal = "JCR (Q"+ highLevel +")";
                }
            }
        }

        String customJournal = mongoLiterature.getCustomJournal();
        if (StringUtils.isNotBlank(customJournal)) {
            kernelJournal = customJournal;
        }
        jcr = jcr + "（"+ kernelJournal +"）";
        innerObj.put("jcr", jcr);
        
        literature.getJSONArray(typeName+"LiteratureDataTable").add(innerObj);
    }

    private void assembleOtherLiterature(String typeName, JSONObject literature, MongoLiterature mongoLiterature) {
            JSONObject innerObj = new JSONObject();
            String reference = buildReference(mongoLiterature);
            innerObj.put("reference", reference);

            // 研究类型
            List<Integer> lastNewType = mongoLiterature.getLastNewType();
            StringBuilder studyTypeBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(lastNewType)) {
                for (Integer type : lastNewType) {
                    switch (type) {
                        case 0:
                            studyTypeBuilder.append("系统综述/Meta分析、");
                            continue;
                        case 1:
                            studyTypeBuilder.append("传统综述、");
                            continue;
                        case 2:
                            studyTypeBuilder.append("随机对照试验、");
                            continue;
                        case 3:
                            studyTypeBuilder.append("队列研究、");
                            continue;
                        case 4:
                            studyTypeBuilder.append("病例对照研究、");
                            continue;
                        case 5:
                            studyTypeBuilder.append("横断面研究、");
                            continue;
                        case 6:
                            studyTypeBuilder.append("病例系列、");
                            continue;
                        case 7:
                            studyTypeBuilder.append("病例报告、");
                            continue;
                        case 8:
                            studyTypeBuilder.append("专家意见和评价、");
                            continue;
                        case 9:
                            studyTypeBuilder.append("动物实验、");
                            continue;
                        case 10:
                            studyTypeBuilder.append("体外实验、");
                            continue;
                        case 11:
                            studyTypeBuilder.append("指南/共识、");
                            continue;
                        case 13:
                            studyTypeBuilder.append("其他、");
                            continue;
                        case 14:
                            studyTypeBuilder.append("临床试验、");
                            continue;
                        default:
                            break;
                    }
                }
                if (CollectionUtils.isNotEmpty(mongoLiterature.getType())) {
                    for (Integer type : mongoLiterature.getType()) {
                        if (type == 7) {
                            studyTypeBuilder.append("临床试验、");
                        }
                    }
                }
            } else {
                studyTypeBuilder.append(" ");
            }
            String studyTypeName = studyTypeBuilder.toString();
            if (StringUtils.isNotBlank(studyTypeName)) {
                studyTypeName = studyTypeName.substring(0, studyTypeName.length() - 1);
            }
            innerObj.put("studyType", studyTypeName);

            String customType = mongoLiterature.getCustomType();
            if (StringUtils.isNotBlank(customType)) {
                innerObj.put("studyType", customType);
            }

            //摘要
            String summary = "-";
            if (StringUtils.isNotBlank(mongoLiterature.getSummary())) {
                summary = mongoLiterature.getSummary();
            }
            innerObj.put("summary", summary);

            // 影响因子
            String jcr = "-";
            if (Objects.nonNull(mongoLiterature.getJcr())) {
                jcr = String.valueOf(mongoLiterature.getJcr());
            }
            //  ++++++
            // 核心期刊
            String kernelJournal = "-";
            String language = mongoLiterature.getLanguage();
            if ("zh".equals(language)) {
                List<String> recognizedKernelJournals = mongoLiterature.getRecognizedKernelJournals();
                StringBuilder zhKernelJournalBuilder = new StringBuilder();
                if (CollectionUtils.isNotEmpty(recognizedKernelJournals)) {
                    for (String recognizedKernelJournal : recognizedKernelJournals) {
                        switch (recognizedKernelJournal){
                            case "Technology":
                                zhKernelJournalBuilder.append("科技核心、");
                                break;
                            case "Peking University":
                                zhKernelJournalBuilder.append("北大核心、");
                                break;
                            case "Nanjing University":
                                zhKernelJournalBuilder.append("南大核心、");
                            case "CSCD":
                                zhKernelJournalBuilder.append("CSCD、");
                                break;
                            default:
                                break;
                        }
                    }
                }
                if (StringUtils.isNotBlank(zhKernelJournalBuilder)) {
                    kernelJournal = zhKernelJournalBuilder.substring(0, zhKernelJournalBuilder.length() - 1);
                }
            } else {
                List<String> journalDivision = mongoLiterature.getJournalDivision();
                List<String> enKernelJournalList = new ArrayList<>();
                if (CollectionUtils.isNotEmpty(journalDivision)) {
                    for (String s : journalDivision) {
                        if (s.contains("-")) {
                            String[] split = Arrays.stream(s.split("-")).distinct().toArray(String[]::new);
                            if (split.length > 1) {
                                String level = s.split("-")[1];
                                level = level.substring(level.indexOf("("), level.indexOf(")") + 1);
                                enKernelJournalList.add("JCR" + level);
                            }
                        }
                    }
                }
                if (CollectionUtils.isNotEmpty(enKernelJournalList)) {
                    List<String> level = new ArrayList<>();
                    enKernelJournalList.stream().distinct().forEach(item -> {
                        if (item.contains("(")) {
                            if (item.contains("N/A")) {
                                level.add("5");
                            } else {
                                level.add(item.substring(item.indexOf("Q") + 1, item.indexOf(")")));
                            }
                        }
                    });
                    List<String> levelSort = level.stream().sorted(Comparator.comparing(String::toString, Comparator.reverseOrder())).collect(Collectors.toList());
                    String highLevel = levelSort.get(0);
                    if (Objects.equals(highLevel, "5")) {
                        kernelJournal = "JCR (N/A)";
//                            kernelJournal = enKernelJournalList.stream().distinct().collect(Collectors.joining("、"));
                    } else {
                        kernelJournal = "JCR (Q"+ highLevel +")";
                    }
                }
            }

            String customJournal = mongoLiterature.getCustomJournal();
            if (StringUtils.isNotBlank(customJournal)) {
                kernelJournal = customJournal;
            }
            jcr = jcr + "（"+ kernelJournal +"）";
            innerObj.put("jcr", jcr);

            literature.getJSONArray(typeName+"LiteratureDataTable").add(innerObj);
    }


    private String buildReference(MongoLiterature mongoLiterature) {
        StringBuilder literatureBuilder = new StringBuilder();
        literatureBuilder.append(" ");
        literatureBuilder.append(StrUtil.isBlank(getThreeAuthorStr(mongoLiterature.getAuthor())) ? "" : getThreeAuthorStr(mongoLiterature.getAuthor()) + ".");
        literatureBuilder.append(StrUtil.isBlank(mongoLiterature.getTitle()) ? "" : HtmlUtil.cleanHtmlTag(mongoLiterature.getTitle()) + ".");
        literatureBuilder.append(StrUtil.isBlank(mongoLiterature.getJournal()) ? "" : (mongoLiterature.getJournal()));
        if (StringUtils.isNotBlank(mongoLiterature.getYear())) {
            literatureBuilder.append(",").append(mongoLiterature.getYear());
        }
        if (CollectionUtils.isNotEmpty(mongoLiterature.getVolume())) {
            literatureBuilder.append(",").append(mongoLiterature.getVolume().get(0));
            if (CollectionUtils.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append("(").append(mongoLiterature.getIssue().get(0)).append(")");
            }
        } else {
            if (CollectionUtils.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append(",").append("(").append(mongoLiterature.getIssue().get(0)).append(")");
            }
        }
        if (StringUtils.isNotBlank(mongoLiterature.getPages())) {
            literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
        } else {
            literatureBuilder.append(".");
        }
        if (literatureBuilder.toString().endsWith("..")) {
            return literatureBuilder.substring(0, literatureBuilder.toString().length() - 2);
        }
        return literatureBuilder.toString();
    }

    /**
     * 安全性 黑框 不练反应 药物警戒 FAERS 数据库
     */
    private void safety(Condition condition, JSONObject result, JSONObject data) {
        String drugAndNotStr = result.getString("drugAndNotStr").replaceAll("&", "合并");
        String firstDrugWord = result.getString("firstDrugWord");
        if (StrUtil.isBlank(firstDrugWord)) {
            firstDrugWord = drugAndNotStr;
        }
        
        //获取不良反应数据
        JSONObject adverseInfo = adverseService.info(condition.getId());

        Date oneDate = new Date();
        // 黑框警告 不良反应总结
        JSONArray instructionArr = new JSONArray();
        // 总结使用
        JSONArray instructionSummary = new JSONArray();
        
        JSONArray infoForAdverse = adverseInfo.getJSONArray("instruction");
        result.put("infoForAdverse", infoForAdverse);
        
        for (int i = 0; i < infoForAdverse.size(); i++) {
            JSONObject innerJson = new JSONObject();
            // 总结使用
            JSONObject inner = new JSONObject();

            JSONObject jsonObject = infoForAdverse.getJSONObject(i);
            Integer type = jsonObject.getInteger("type");
            innerJson.put("type", type);
            
            if (CollectionUtils.isNotEmpty(jsonObject.getJSONArray("taboo"))) {
                innerJson.put("taboo", jsonObject.getJSONArray("taboo"));
            } else {
                innerJson.put("taboo", "");
            }

            if (CollectionUtils.isNotEmpty(jsonObject.getJSONArray("pregnantWomen"))) {
                innerJson.put("pregnantWomen", jsonObject.getJSONArray("pregnantWomen"));
            } else {
                innerJson.put("pregnantWomen", "");
            }

            if (CollectionUtils.isNotEmpty(jsonObject.getJSONArray("children"))) {
                innerJson.put("children", jsonObject.getJSONArray("children"));
            } else {
                innerJson.put("children", "");
            }

            if (CollectionUtils.isNotEmpty(jsonObject.getJSONArray("geriatric"))) {
                innerJson.put("geriatric", jsonObject.getJSONArray("geriatric"));
            } else {
                innerJson.put("geriatric", "");
            }
            innerJson.put("liverFunction", "");

            if (CollectionUtils.isNotEmpty(jsonObject.getJSONArray("notes"))) {
                innerJson.put("notes", jsonObject.getJSONArray("notes"));
            } else {
                innerJson.put("notes", "");
            }

            JSONArray adverse = jsonObject.getJSONArray("adverse");
            if (CollectionUtils.isNotEmpty(adverse)) {
                innerJson.put("adverse", adverse);
                StringBuilder adverseBuilder = new StringBuilder();
                for (Object o : adverse) {
                    JSONObject oObj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                    String tag = oObj.getString("tag");
                    if ("text".equals(tag)) {
                        adverseBuilder.append(oObj.getString("content"));
                    }
                }
                String question = "你是一位专业的医学翻译专家，请按以下步骤处理文本：\n" +
                        "1. 对提供的说明书不良反应内容进行整理：\n   " +
                        "   - 保留所有首次出现的不良反应术语（按系统器官分类/SOC归类，若原文无分类则按原文顺序）\n   " +
                        "   - 标注剂量依赖性说明（如「剂量≥X mg时发生率增加」）\n   " +
                        "   - 提取人群特征标注（如「老年人发生率更高」「肝功能不全患者AUC升高」）\n   " +
                        "   - 保留发生率数据（如「≥10%」「＜0.1%」）及其对应样本量说明\n" +
                        "2. 在保持原文医学术语和数据完整性的前提下进行语言标准化：\n   " +
                        "   - 统一使用MedDRA/WHOART标准术语表述（如将「肝酶升高」改为「转氨酶升高」）\n   " +
                        "   - 规范剂量单位（如统一为「mg/kg」）\n   " +
                        "   - 标准化人群标注格式（如「Child-Pugh C级患者」）\n" +
                        "3. 返回格式要求：\n" +
                        "   ```json\n" +
                        "   {\n  " +
                        "       \"summary\": \"[整理后的内容，使用一段文本展示]\"\n" +
                        "   }\n" +
                        "   ```\n" +
                        "严格要求：\n" +
                        "   - 不得合并不同不良反应（如「恶心/腹泻」需保留为两个条目）\n" +
                        "   - 保留原文全部定性描述（如「暂时性」「可逆性」）\n" +
                        "   - 对多源数据采用「;」分隔（如不同研究数据）\n" +
                        "   - 禁止添加原文未提及的因果关系或分类\n" +
                        "请严格返回JSON格式数据体（不要包含任何解释性内容）\n" +
                        "输入文本：{{" + adverseBuilder + "}}";

                JSONObject summaryObj = retryUtils.executeWithRetryOld(question, Constants.QWEN3_MAX_2025_09_23_60_PRM, JSONObject.class, "说明书不良反应总结", PriorityConstants.PRIORITY_HIGH);
                String summary = summaryObj.getString("summary");
                result.put("adverseSummary", summary);
            } else {
                innerJson.put("adverse", "");
            }

            JSONArray warning = jsonObject.getJSONArray("warning");
            if (CollectionUtils.isNotEmpty(warning)) {
                innerJson.put("warning", warning);
                
                StringBuilder warningBuilder = new StringBuilder();
                List<Map<String, Object>> maps = JSON.parseObject(JSON.toJSONString(warning), new TypeReference<List<Map<String, Object>>>() {
                });
                for (Map<String, Object> map : maps) {
                    String innerResult;
                    String tag = map.get("tag").toString();
                    if ("text".equals(tag)) {
                        if (Objects.isNull(map.get("content"))){
                            continue;
                        }
                        innerResult = map.get("content").toString();
                        innerResult = wiffOfContent(innerResult, "<br>", "");
                        innerResult = wiffOfContent(innerResult, "</br>", "");
                        warningBuilder.append(wiffOfContent(innerResult, "\n\n", "\n"));
                    }
                }
                inner.put("warning", warningBuilder.toString());
            } else {
                innerJson.put("warning", "");
            }
            
            innerJson.put("name", jsonObject.getString("name"));
            inner.put("name", jsonObject.getString("name"));
            instructionArr.add(innerJson);
            instructionSummary.add(inner);
        }
        log.info("安全分析模块-说明书完成，花费时间{}", new Date().getTime() - oneDate.getTime());
        data.put("drugInfos", instructionArr);
        result.put("instructionSummary", instructionSummary);

        // 药物警戒
        JSONObject policy = adverseInfo.getJSONObject("policy");
        JSONObject newsFlash = policy.getJSONObject("newsFlash");
        if (Objects.nonNull(newsFlash)) {
            data.put("newsFlash", newsFlash);
        }
        result.put("newsFlash", newsFlash);
        
        JSONObject report = policy.getJSONObject("report");
        if (Objects.nonNull(report)) {
            data.put("report", report);
        }
        result.put("report", report);

        // 信号分析
        JSONObject signalAnalysis = new JSONObject();
        JSONObject adverse = adverseInfo.getJSONObject("adverse");
        JSONObject signalAnalysis_ = adverse.getJSONObject("calculateTypicalSignals");
        if (Objects.nonNull(signalAnalysis_)) {
            signalAnalysis.put("signalAnalysis", signalAnalysis_);
            String total = "0";
            String str_signalAnalysis = "";

            String signalAnalysisSTotal = signalAnalysis_.getString("total");
            if (Objects.nonNull(signalAnalysisSTotal)) total = signalAnalysisSTotal;
            
            JSONArray drugAnd = result.getJSONArray("drugAnd");
            
            if (!"0".equals(total)) {
                if (!drugAnd.isEmpty()) {
                    str_signalAnalysis = "截止至2025年12月31日，FAERS数据库上报的所有不良反应数据中，以" + firstDrugWord + "为PS的ADE报告共" + total +"例。";
                } else {
                    str_signalAnalysis = "";
                }
            } else {
                str_signalAnalysis = "截止至2025年12月31日，暂未检索到FAERS数据库中，以" + firstDrugWord + "为主要怀疑药物的相关不良反应报告。";
            }
            signalAnalysis.put("desc", str_signalAnalysis);
        }
        data.put("signalAnalysis", signalAnalysis);

        // 严重不良反应分析
        JSONObject severeAdverseAnalysis = new JSONObject();
        JSONArray severeAdverseAnalysis_ = adverse.getJSONArray("seriousAdverse");
        severeAdverseAnalysis.put("severalAdverse", severeAdverseAnalysis_);

        String str_severeAdverseAnalysis = "";
        if (!severeAdverseAnalysis_.isEmpty()) {
            JSONObject maxPer = severeAdverseAnalysis_.getJSONObject(0);
            Integer num = maxPer.getInteger("num");
            String name = maxPer.getString("name");
            String percent = maxPer.getString("percent");
            str_severeAdverseAnalysis = "以上报告中，严重不良反应结局分类中以"+ name +"占比最高"+(percent) + "。" ;

        }
        severeAdverseAnalysis.put("desc", str_severeAdverseAnalysis);
        data.put("severeAdverseAnalysis", severeAdverseAnalysis);
    }

    private void conclusion(JSONObject result, JSONObject data) {
        String drugAndNotStr = result.getString("drugAndNotStr").replaceAll("&", "、");
        String diseaseAndNotStr = result.getString("diseaseAndNotStr").replaceAll("&", "、");
        
        int guideCount = result.getInteger("guideIncludeCount");
        int metaCount = result.getInteger("metaIncludeCount");
        int rctCount = result.getInteger("rctIncludeCount");

        String template = "%s用于%s";
        String drugDisease = String.format(template, drugAndNotStr, diseaseAndNotStr);

        StringBuilder sbOne = new StringBuilder();
        Map<String, Boolean> approvals = new LinkedHashMap<>();
        approvals.put("FDA", result.getBoolean("fda"));
        approvals.put("EMA", result.getBoolean("ema"));
        approvals.put("PMDA", result.getBoolean("pmda"));

        Map<Boolean, List<String>> groupedApprovals = approvals.entrySet().stream()
                .collect(Collectors.partitioningBy(
                        entry -> Boolean.TRUE.equals(entry.getValue()),
                        Collectors.mapping(Map.Entry::getKey, Collectors.toList())
                ));

        List<String> approved = groupedApprovals.get(true);
        List<String> notApproved = groupedApprovals.get(false);

        if (approved.size() == approvals.size()) {
            sbOne.append(String.join("、", approved))
                    .append("均已批准")
                    .append(drugDisease)
                    .append("的治疗。");
        } else if (approved.isEmpty()) {
            sbOne.append(String.join("、", notApproved))
                    .append("均未批准")
                    .append(drugDisease)
                    .append("的治疗。");
        } else {
            sbOne.append(String.join("、", approved))
                    .append("已批准")
                    .append(drugDisease)
                    .append("的治疗；")
                    .append(String.join("、", notApproved))
                    .append("未批准。");
        }

        StringBuilder sbTwo = new StringBuilder();
        // 指南部分
        sbTwo.append(guideCount > 0 ?
                String.format("有%d篇指南阐述或推荐了%s。", guideCount, drugDisease) :
                String.format("暂无指南阐述或推荐了%s。", drugDisease));

        sbTwo.append("\n");
        // 证据部分
        if (metaCount > 0 || rctCount > 0) {
            List<String> evidence = Stream.of(
                    metaCount > 0 ? metaCount + "篇 META" : null,
                    rctCount > 0 ? rctCount + "篇 RCT" : null
            ).filter(Objects::nonNull).collect(Collectors.toList());

            sbTwo.append(String.format("有%s等证据显示%s方面有疗效。",
                    String.join("、", evidence), drugDisease));
        } else {
            sbTwo.append(String.format("暂无文献证据显示%s方面有疗效。", drugDisease));
        }


        StringBuilder sbThree = new StringBuilder();

        JSONArray instructionSummary = result.getJSONArray("instructionSummary");
        List<JSONObject> warnings;

        if (instructionSummary == null) {
            warnings = Collections.emptyList();
        } else {
            warnings = instructionSummary.stream()
                    .map(obj -> JSON.parseObject(JSON.toJSONString(obj), JSONObject.class))
                    .filter(json -> Objects.nonNull(json.getString("warning")))
                    .collect(Collectors.toList());
        }
       
        sbThree.append("安全性方面，");   
        if (CollectionUtils.isNotEmpty(warnings)) {
            for (int i = 0; i < warnings.size(); i++) {
                JSONObject warning = warnings.get(i);
                sbThree.append(warning.getString("name"))
                        .append(warning.getString("warning"));

                if (i < warnings.size() - 1) {
                    sbThree.append("\n");
                }
            }
        } else {
            sbThree.append(String.format("暂未查询到%s的黑框警告信息。", drugAndNotStr));
        }

        sbThree.append("\n");

        JSONObject newsFlash = result.getJSONObject("newsFlash");
        if (newsFlash == null) {
            sbThree.append(String.format("暂未查询到NMPA关于%s的药物警戒信息。", drugAndNotStr));
        } else {
            JSONArray nmpa = newsFlash.getJSONArray("nmpa");
            if (CollectionUtils.isNotEmpty(nmpa)) {
                nmpa.forEach(item -> {
                    JSONObject flash = JSON.parseObject(JSON.toJSONString(item), JSONObject.class);
                    sbThree.append(String.format("%s -%s(发布时间：%s)",
                            flash.getString("title"),
                            flash.getString("content"),
                            flash.getString("dataTime"))).append("\n");
                });
            } else {
                sbThree.append(String.format("暂未查询到NMPA关于%s的药物警戒信息。", drugAndNotStr));
            }
        }

        String adverseSummary = result.getString("adverseSummary");
        if (StringUtils.isNotBlank(adverseSummary)) {
            sbThree.append("\n");
            sbThree.append(adverseSummary);
        }
        
        JSONArray conclusion = new JSONArray();
        conclusion.add(sbOne.toString());
        conclusion.add(sbTwo.toString());
        conclusion.add(sbThree.toString().replaceAll("\n\n", "\n"));
        data.put("analysisConclusion", conclusion);
    }


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

    private void createTableForLiteratureMutilField(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = new Font(null, 12, Font.NORMAL);

        //创建表格
        Table table = new Table(9);
        //设置边框
        table.setBorder(1);
        table.setWidths(new float[]{0.05f, 0.1f, 0.05f, 0.1f, 0.1f, 0.3f, 0.1f, 0.1f, 0.1f});
        table.setWidth(100);

        Cell[] cellHeaders = new Cell[9];
        cellHeaders[0] = new Cell(new Phrase("序号", fontNormal_12));
        cellHeaders[1] = new Cell(new Phrase("文献来源", fontNormal_12));
        cellHeaders[2] = new Cell(new Phrase("年份", fontNormal_12));
        cellHeaders[3] = new Cell(new Phrase("研究类型", fontNormal_12));
        cellHeaders[4] = new Cell(new Phrase("研究疾病", fontNormal_12));
        cellHeaders[5] = new Cell(new Phrase("试验组/对照组", fontNormal_12));
        cellHeaders[6] = new Cell(new Phrase("影响因子", fontNormal_12));
        cellHeaders[7] = new Cell(new Phrase("核心期刊", fontNormal_12));
        cellHeaders[8] = new Cell(new Phrase("文献质量", fontNormal_12));
        verticalAndHorizontalAlignment(cellHeaders, false);
        tableAddCell(table, cellHeaders);

        for (Object o : literatureDataTable) {
            JSONObject paper = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);

            Cell[] cell = new Cell[9];
            cell[0] = new Cell(new Phrase(paper.getString("number"), fontNormal_12));
            String source = paper.getString("source");
            source = source.replaceAll("</sup>", "").replaceAll("<sup>", "");
            cell[1] = new Cell(new Phrase(source, fontNormal_12));
            cell[2] = new Cell(new Phrase(paper.getString("year"), fontNormal_12));
            cell[3] = new Cell(new Phrase(paper.getString("studyType"), fontNormal_12));
            cell[4] = new Cell(new Phrase(paper.getString("studyDiseaseName"), fontNormal_12));
            cell[5] = new Cell(new Phrase(paper.getString("ic"), fontNormal_12));
            cell[6] = new Cell(new Phrase(paper.getString("jcr"), fontNormal_12));
            cell[7] = new Cell(new Phrase(paper.getString("kernelJournal"), fontNormal_12));
            cell[8] = new Cell(new Phrase(paper.getString("qualityMeta"), fontNormal_12));
            verticalAndHorizontalAlignment(cell, false);
            tableAddCell(table, cell);

            Cell[] cell_2_1 = new Cell[2];
            cell_2_1[0] = new Cell(new Phrase("结局指标", fontNormal_12));
            cell_2_1[1] = new Cell(new Phrase(paper.getString("index"), fontNormal_12));
            cell_2_1[1].setColspan(8);
            verticalAndHorizontalAlignment(cell_2_1, false);
            tableAddCell(table, cell_2_1);

            Cell[] cell_2_2 = new Cell[2];
            cell_2_2[0] = new Cell(new Phrase("结论", fontNormal_12));
            cell_2_2[1] = new Cell(new Phrase(paper.getString("conclusion"), fontNormal_12));
            cell_2_2[1].setColspan(8);
            verticalAndHorizontalAlignment(cell_2_2, false);
            tableAddCell(table, cell_2_2);
        }
        //将表格添加到文档中
        document.add(table);
    }


    private void createTableForLiterature(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = new Font(null, 12, Font.NORMAL);

        for (Object o : literatureDataTable) {
            //创建表格
            Table table = new Table(2);
            //设置边框
            table.setBorder(1);
            table.setWidths(new float[]{0.2f, 0.8f});
            table.setWidth(100);

            Cell[] cell_2 = new Cell[2];

            JSONObject obj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
            cell_2[0] = new Cell(new Phrase("参考文献", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("reference"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            cell_2[0] = new Cell(new Phrase("摘要", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("summary"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            cell_2[0] = new Cell(new Phrase("影响因子（分区）", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("jcr"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            //将表格添加到文档中
            document.add(table);
        }
    }

    private void createTableForOtherLiterature(JSONArray literatureDataTable, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = new Font(null, 12, Font.NORMAL);
        
        for (Object o : literatureDataTable) {
            //创建表格
            Table table = new Table(2);
            //设置边框
            table.setBorder(1);
            table.setWidths(new float[]{0.2f, 0.8f});
            table.setWidth(100);

            Cell[] cell_2 = new Cell[2];
            JSONObject obj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
            cell_2[0] = new Cell(new Phrase("参考文献", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("reference"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            cell_2[0] = new Cell(new Phrase("类型", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("studyType"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            cell_2[0] = new Cell(new Phrase("摘要", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("summary"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            cell_2[0] = new Cell(new Phrase("影响因子", fontNormal_12));
            cell_2[1] = new Cell(new Phrase(obj.getString("jcr"), fontNormal_12));
            verticalAndHorizontalAlignmentCus1(cell_2, Arrays.asList(0));
            tableAddCell(table, cell_2);

            //将表格添加到文档中
            document.add(table);
        }
    }

    private void createTableForDBAnalysis(JSONArray data, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = new Font(null, 12, Font.NORMAL);
        //创建表格
        Table table = createTableHeader(6);

        //第一行（表格）
        if (CollectionUtils.isNotEmpty(data)) {
            Cell[] cellHeaders = new Cell[6];
            cellHeaders[0] = new Cell(new Phrase("SOC分类/首选术语（PT）", fontNormal_12));
            cellHeaders[1] = new Cell(new Phrase("不良事件", fontNormal_12));
            cellHeaders[2] = new Cell(new Phrase("报告数/例", fontNormal_12));
            cellHeaders[3] = new Cell(new Phrase("ROR值(95%CI)", fontNormal_12));
            cellHeaders[4] = new Cell(new Phrase("EBGM值", fontNormal_12));
            cellHeaders[5] = new Cell(new Phrase("IC值(95%CI)", fontNormal_12));

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
                    String seven = jsonObject.get("seven").toString();
                    String eight = jsonObject.get("eight").toString();
                    ror = jsonObject.get("ror").toString();
                    ror = ror + "\n" + "["+ seven +","+ eight +"]";
                }
                String ebgm = "";
                if (Objects.nonNull(jsonObject.get("ebgm"))) {
                    ebgm = jsonObject.get("ebgm").toString();
                }
                String ic = "";
                if (Objects.nonNull(jsonObject.get("ic"))) {
                    String nine = jsonObject.get("nine").toString();
                    String ten = jsonObject.get("ten").toString();
                    ic = jsonObject.get("ic").toString();
                    ic = ic + "\n" + "["+ nine +","+ ten +"]";
                }
                cell_6[0] = new Cell(new Phrase(soc, fontNormal_12));
                cell_6[1] = new Cell(new Phrase(en + "(" + zh + ")", fontNormal_12));
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

    private void createTableForSeveralAdverse(JSONArray severalAdverse, Document document) throws DocumentException {
        //设置字体
        Font fontNormal_12 = new Font(null, 12, Font.NORMAL);
        //创建表格
        Table table = createTableHeader(2);

        Cell[] cell_2 = new Cell[2];
        if (CollectionUtils.isNotEmpty(severalAdverse)) {
            cell_2[0] = new Cell(new Phrase("严重不良反应结局", fontNormal_12));
            cell_2[1] = new Cell(new Phrase("数量", fontNormal_12));
            verticalAndHorizontalAlignment(cell_2, false);
            tableAddCell(table, cell_2);
            for (int i = 0; i < severalAdverse.size(); i++) {
                Object o = severalAdverse.get(i);
                JSONObject jsonObject = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                cell_2[0] = new Cell(new Phrase(jsonObject.getString("name"), fontNormal_12));
                cell_2[1] = new Cell(new Phrase(String.valueOf(jsonObject.getLong("num")), fontNormal_12));
                verticalAndHorizontalAlignment(cell_2, false);
                tableAddCell(table, cell_2);
            }
        }
        //将表格添加到文档中
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

    /**
     * 设置 不进行缩进的文本
     */
    private void setNoFirstLineContent(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);
        //去除换行符
//        value = value.replaceAll("\n", "");
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_LEFT);
        content.setFont(font);
        content.setSpacingBefore(5f);
//        content.setSpacingAfter(15f);
        document.add(content);
    }

    /**
     * 增加空白行
     */
    private void addBlank(Document document, int n) throws DocumentException {
        Paragraph blankSpace = new Paragraph("");
        Font blankSize = new Font(null, 12, Font.NORMAL);
        blankSpace.setFont(blankSize);
        for (int i = 0; i < n; i++) {
            document.add(blankSpace);
        }
    }
    
    /**
     * 设置标题字体
     * @param value 标题内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setTitle(String value, Document document) throws DocumentException {
        Font font = new Font(null, 14, Font.BOLD);
        Paragraph title = new Paragraph(value);
        // 设置标题格式对齐方式
        title.setAlignment(Element.ALIGN_LEFT);
        title.setFont(font);
        title.setSpacingBefore(15f);
        title.setSpacingBefore(15f);
        document.add(title);
    }

    /**
     * 设置文本字体
     * @param value 文本内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setContent(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);
        //去除换行符
//        value = value.replaceAll("\n", "");
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        content.setFirstLineIndent(30);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_LEFT);
        content.setFont(font);
        content.setSpacingBefore(15f);
        content.setSpacingBefore(15f);
        document.add(content);
    }

    private void setContentBold(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.BOLD);
        //去除换行符
//        value = value.replaceAll("\n", "");
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        content.setFirstLineIndent(30);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_LEFT);
        content.setFont(font);
        content.setSpacingBefore(15f);
        content.setSpacingBefore(15f);
        document.add(content);
    }

    /**
     * 设置文本字体
     * @param value 文本内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setCenterContent(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL);
        //去除换行符
//        value = value.replaceAll("\n", "");
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        content.setFirstLineIndent(30);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_CENTER);
        content.setFont(font);
        content.setSpacingBefore(15f);
        content.setSpacingBefore(15f);
        document.add(content);
    }

    /**
     * 右侧小标题显示
     */
    private void setContentAi(String value, Document document) throws DocumentException {
        Font font = new Font(null, 12, Font.NORMAL, Color.GRAY);
        Paragraph content = new Paragraph(value);
        // 段前间距
        content.setSpacingBefore(5f);
        content.setIndentationRight(5f);
        content.setAlignment(1);
        content.setFont(font);
        document.add(content);
    }

    /**
     * 设置文本字体
     * @param value 文本内容
     * @param document 文档
     * @throws DocumentException 文档异常
     */
    private void setContentNoRetract(String value, Document document) throws DocumentException {
        Font font = new Font(null, 14, Font.NORMAL);
        //去除换行符
        value = HtmlUtil.removeAllHtmlAttr(value);
        Paragraph content = new Paragraph(value);
        // 设置标题格式对齐方式
        content.setAlignment(Element.ALIGN_LEFT);
        content.setFont(font);
        content.setSpacingBefore(15f);
        content.setSpacingBefore(15f);
        document.add(content);
    }

    /**
     * 设置页码
     * @param document 文档
     */
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

    /**
     * @param content 原文
     * @param oldChar 被替换的内容
     * @param newChar 需要替换的内容
     */
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        if (content.contains(oldChar)) {
            return content.replaceAll(oldChar, newChar);
        }
        return content;
    }
    private String getThreeAuthorStr(List<String> author) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollectionUtils.isNotEmpty(author)) {
            for (int i = 0; i < author.size(); i++) {
                stringBuilder.append(",").append(author.get(i));
                if (i == 2) {
                    break;
                }
            }
        }
        return stringBuilder.length() == 0 ? "" : stringBuilder.substring(1, stringBuilder.length());
    }

    public void assembleListData(JSONArray data, Document document) {
        List<Map<String, Object>> maps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<List<Map<String, Object>>>() {
        });
        if (CollectionUtils.isNotEmpty(maps)) {
            for (Map<String, Object> map : maps) {
                String result;
                String tag = map.get("tag").toString();
                if ("text".equals(tag)) {
                    if (Objects.isNull(map.get("content"))) continue;
                    result = map.get("content").toString();
                    try {
                        setContent(wiffOfContent(result, "\n\n", "\n"), document);
                    } catch (DocumentException e) {
                        log.error(e.getMessage(), e);
                    }
                }
                if ("img".equals(tag)) {
                    if (Objects.isNull(map.get("content"))) continue;
                    String base64String = map.get("content").toString();
                    try {
                        // 移除Base64数据前缀 "data:image/jpeg;base64," 或其他格式的前缀，如果你的字符串包含这些的话
                        base64String = base64String.replaceAll("^(data:image\\/.*;base64,)", "");
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

    /**
     * 加入表格到 document
     */
    private void tableAddCell(Table table, Cell[] cell) {
        if (Objects.nonNull(cell)) {
            for (Cell cell1 : cell) {
                table.addCell(cell1);
            }
        }
    }

    /**
     * 表格居中
     */
    private void verticalAndHorizontalAlignmentCus1(Cell[] cell, List<Integer> centerNumbers) {
        if (Objects.nonNull(cell) && cell.length > 0) {
            for (int i = 0; i < cell.length; i++) {
                if (centerNumbers.contains(i)) {
                    cell[i].setVerticalAlignment(Element.ALIGN_MIDDLE);
                    cell[i].setHorizontalAlignment(Element.ALIGN_CENTER);
                } else {
                    cell[i].setVerticalAlignment(Element.ALIGN_LEFT);
                    cell[i].setHorizontalAlignment(Element.ALIGN_LEFT);
                }    
            }
        }
    }


    /**
     * 表格居中
     */
    private void verticalAndHorizontalAlignment(Cell[] cell, boolean firstCellLeft) {
        if (Objects.nonNull(cell) && cell.length > 0) {
            for (int i = 0; i < cell.length; i++) {
                if (firstCellLeft && i == 0) continue;
                cell[i].setVerticalAlignment(Element.ALIGN_MIDDLE);
                cell[i].setHorizontalAlignment(Element.ALIGN_CENTER);
            }
        }
    }

}
