package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.auth0.jwt.interfaces.Claim;
import com.google.common.net.HttpHeaders;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.mongo.Question;
import com.sentum.evidencecomprehensive.domain.mongo.ReportContent;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.EditMultiContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.GenTemplateRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveTemplateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.ClickReportResponse;
import com.sentum.evidencecomprehensive.feign.ManageFeign;
import com.sentum.evidencecomprehensive.feign.PharmacyFeign;
import com.sentum.evidencecomprehensive.handler.KafkaSender;
import com.sentum.evidencecomprehensive.service.QuestionService;
import com.sentum.evidencecomprehensive.service.ReportNewService;
import com.sentum.evidencecomprehensive.service.handler.ResponseRegistry;
import com.sentum.evidencecomprehensive.utils.operateyl.JwtUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import com.vladsch.flexmark.ext.tables.TablesExtension;
import com.vladsch.flexmark.html.HtmlRenderer;
import com.vladsch.flexmark.parser.Parser;
import com.vladsch.flexmark.util.ast.Node;
import com.vladsch.flexmark.util.data.MutableDataSet;
import feign.Response;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.apache.poi.util.Units;
import org.apache.poi.xwpf.model.XWPFHeaderFooterPolicy;
import org.apache.poi.xwpf.usermodel.*;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.TextNode;
import org.jsoup.select.Elements;
import org.openxmlformats.schemas.wordprocessingml.x2006.main.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.*;
import java.math.BigInteger;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/10
 */
@Slf4j
@Service
public class ReportNewServiceImpl implements ReportNewService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private PharmacyFeign pharmacyFeign;
    @Autowired
    private QuestionService questionService;
    @Autowired
    private JwtUtils jwtUtils;
    @Autowired
    private ManageFeign manageFeign;
    @Autowired
    private KafkaSender kafkaSender;
    @Value("${download.url}")
    private String downloadUrl;

    // 在类级别定义锁容器
    private final ConcurrentHashMap<String, Object> responseLocks = new ConcurrentHashMap<>();


    @Override
    public void createReportTemplateApp(String id, String verifyToken, String token, long userId, HttpServletRequest request) {
        Date startDate = new Date();
        if (StrUtil.isBlank(id)) {
            return;
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return;
        }

//        String token = verifyTokenValid(verifyToken);
        List<String> prompt = new ArrayList<>();
        String template = pharmacyFeign.reportTemplateAI(id);
        prompt.addAll(Arrays.stream(template.split(";")).map(String::trim).collect(Collectors.toList()));
//        tokenInvalid(verifyToken);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            // 更新数据库中的 completeness 字段为 false
            Update update = new Update();
            update.set("completeness", -1);
            mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
            log.info("程序中断，设置 completeness 为 false。报告ID: {}", id);
        }));

        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        String medicine = drugs.stream().filter(drug -> drug.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("联合"));
        String disease = "";
        if (CollUtil.isNotEmpty(diseases)) {
            disease = diseases.stream().filter(dis -> dis.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("合并"));
        }
        String requestId = UUID.randomUUID().toString();
        try (Response responseResult = pharmacyFeign.fillTemplate(id, medicine, disease, userId, requestId);) {
            Response.Body body = responseResult.body();
            InputStream inputStream = body.asInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                if (StringUtils.isBlank(line)) {
                    continue;
                }
            }

            ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
            try {
                JSONObject dataJson = new JSONObject();
                dataJson.put("report_id", id);
                dataJson.put("user_id", userId);
                dataJson.put("function", "循证综合评价");
                dataJson.put("module", "药学");
                dataJson.put("report_name", Objects.nonNull(reportContent) ? reportContent.getTitle(): "未知");
                dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
                manageFeign.addReportInfo(dataJson);
            } catch (Exception e) {
                log.error("循证报告添加机构汇总异常" + e.getCause());
            }

            // app 使用
            //发送kafka生成报告进行微信展示
            log.info("开始发送kafka创建文件--{}", id);
            JSONObject dataJson = new JSONObject();
            dataJson.put("id", id);
            dataJson.put("userId", userId);
            dataJson.put("token", token);
            dataJson.put("type", "循证综合评价报告");
            dataJson.put("name", Objects.nonNull(reportContent) ? reportContent.getTitle() + ".doc" : "未知" + ".doc");
            dataJson.put("url", downloadUrl + "?id=" + id +"&source=app");
            Date endDate = new Date();
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            dataJson.put("startTime", format.format(startDate));
            dataJson.put("endTime", format.format(endDate));
            kafkaSender.sendReportInfo(dataJson);
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
        
    }

    @Override
    public void fillTemplate(GenTemplateRequest genTemplateRequest, long userId, String token, HttpServletResponse response){
        Date startDate = new Date();
        String id = genTemplateRequest.getId();
        if (StrUtil.isBlank(id)) {
            return ;
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return ;
        }

        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        String medicine = drugs.stream().filter(drug -> drug.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("联合"));
        String disease = "";
        if (CollUtil.isNotEmpty(diseases)) {
            disease = diseases.stream().filter(dis -> dis.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("合并"));
        }

        final String threadRequestId = UUID.randomUUID().toString();
        
        if (response != null) {
            // 注册响应对象
            ResponseRegistry.register(threadRequestId, response);
        }       
        
        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        try {
            reportContent = mongoTemplate.findById(id, ReportContent.class);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        if (Objects.nonNull(reportContent)) {
            if (!reportContent.isChangeOutline()) {
                String content = reportContent.getContent();
                if (Objects.nonNull(response) && StrUtil.isNotBlank(content)) {
                    write(content, threadRequestId);
                    return;
                }
            }
            if (reportContent.getCompleteness() == -1 || reportContent.isChangeOutline()) {
                // 更改了 大纲需要把之前缓存过的右侧 文献信息 置空
                Update update = new Update();
                update.set("paperRight", "");
                mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
            }
        }

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            // 更新数据库中的 completeness 字段为 false
            Update update = new Update();
            update.set("completeness", -1);
            mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
            log.info("程序中断，设置 completeness 为 false。报告ID: {}", id);
        }));

        try (Response responseResult = pharmacyFeign.fillTemplate(id, medicine, disease, userId, threadRequestId);) {
            Response.Body body = responseResult.body();
            try (InputStream inputStream = body.asInputStream(); BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (StringUtils.isBlank(line)) {
                        continue;
                    }
                    
                    // 直接写入，已经验证了 requestId
                    write(line, threadRequestId);
                }
            }


            reportContent = mongoTemplate.findById(id, ReportContent.class);
            try {
                JSONObject dataJson = new JSONObject();
                dataJson.put("report_id", id);
                dataJson.put("user_id", userId);
                dataJson.put("function", "循证综合评价");
                dataJson.put("module", "药学");
                dataJson.put("report_name", Objects.nonNull(reportContent) ? reportContent.getTitle(): "未知");
                dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
                manageFeign.addReportInfo(dataJson);
            } catch (Exception e) {
                log.error("循证报告添加机构汇总异常" + e.getCause());
            }

            // app 使用
            //发送kafka生成报告进行微信展示
            log.info("开始发送kafka创建文件--{}", id);
            JSONObject dataJson = new JSONObject();
            dataJson.put("id", id);
            dataJson.put("userId", userId);
            dataJson.put("token", token);
            dataJson.put("type", "循证综合评价报告");
            dataJson.put("name", Objects.nonNull(reportContent) ? reportContent.getTitle() + ".doc" : "未知" + ".doc");
            dataJson.put("url", downloadUrl + "?id=" + id +"&source=" + genTemplateRequest.getSource());
            Date endDate = new Date();
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            dataJson.put("startTime", format.format(startDate));
            dataJson.put("endTime", format.format(endDate));
            kafkaSender.sendReportInfo(dataJson);
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
    }


    @Override
    public List<String> createReportTemplate(String id, String verifyToken, long userId, HttpServletRequest request){
        if (StrUtil.isBlank(id)) {
            return new ArrayList<>();
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return new ArrayList<>();
        }

        List<String> prompt = new ArrayList<>();
        String oriTempKey = Constants.TEMPLATE_ORI + id;
        String oriTemplate = RedisUtils.getStr(oriTempKey);
        if (StrUtil.isNotBlank(oriTemplate)) {
            prompt = Arrays.stream(oriTemplate.split(";")).map(String::trim).collect(Collectors.toList());
            String modiTempKey = Constants.TEMPLATE_MODI + id;
            String modiTemplate = RedisUtils.getStr(modiTempKey);
            if (StrUtil.isNotBlank(modiTemplate)) {
                prompt = Arrays.stream(modiTemplate.split(";")).map(String::trim).collect(Collectors.toList());
            }
        }
        String token = verifyTokenValid(verifyToken);
        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        if (reportContent == null) {
            questionService.create(id, userId, request);
        } else {
            if (StrUtil.isNotBlank(token)) {
                //保存课题历史
                questionService.generateHistoricalRecords(id);
                prompt.clear();
            } else {
                if (CollUtil.isNotEmpty(prompt)) {
                    return prompt;
                }
            }
        }

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            // 更新数据库中的 completeness 字段为 false
            Update update = new Update();
            update.set("completeness", -1);
            mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
            log.info("程序中断，设置 completeness 为 false。报告ID: {}", id);
        }));

        String template = pharmacyFeign.reportTemplateAI(id);
        prompt.addAll(Arrays.stream(template.split(";")).map(String::trim).collect(Collectors.toList()));
        tokenInvalid(verifyToken);
        return prompt;
    }

    @Override
    public void saveTemplate(SaveTemplateRequest saveTemplateRequest) {
        String id = saveTemplateRequest.getId();
        if (StrUtil.isBlank(id)) {
            return;
        }

        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return;
        }
        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        
        List<String> prompt = saveTemplateRequest.getPrompt();
        if (CollUtil.isNotEmpty(prompt)) {
            String oriTempKey = Constants.TEMPLATE_ORI + id;
            String oriTemplate = RedisUtils.getStr(oriTempKey);
            if (StrUtil.isNotBlank(oriTemplate)) {
                // 编辑之后的大纲
                String template = String.join(";", prompt);

                String modiTempKey = Constants.TEMPLATE_MODI + id;
                String modiTemplate = RedisUtils.getStr(modiTempKey);
                if (StrUtil.isNotBlank(modiTemplate)) {
                    RedisUtils.del(modiTempKey);
                }
                RedisUtils.set(modiTempKey, template);
                if (Objects.nonNull(reportContent)) {
                    Update update = new Update();
                    update.set("changeOutline", true);
                    mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
                } else {
                    reportContent = new ReportContent();
                    reportContent.setId(id);
                    reportContent.setChangeOutline(true);
                }        
            } 
        }
    }

    @Override
    public void saveContent(SaveContentRequest saveContentRequest) {
        String id = saveContentRequest.getId();
        if (StrUtil.isBlank(id)) {
            return ;
        }
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.isNull(condition)) {
            return ;
        }

        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        if (Objects.nonNull(reportContent)) {
            
            JSONObject overCon = new JSONObject();
            String contChange = saveContentRequest.getContChange();
            if (StrUtil.isNotBlank(contChange)) {
                overCon.put("data", contChange);
            }

            String contHtml = saveContentRequest.getContHtml();
            if (StrUtil.isNotBlank(contHtml)) {
                overCon.put("dataHtml", contHtml);
            }

            Update update = new Update();
            update.set("content", JSON.toJSONString(overCon));
            String wordHtml = saveContentRequest.getWordHtml();
            if (StrUtil.isNotBlank(wordHtml)) {
                update.set("wordHtml", wordHtml);
            }            
            mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
        }
        
    }

    @Override
    public List<JSONObject> searchReportRight(String id) {

        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        if (Objects.nonNull(reportContent)) {
            String paperRight = reportContent.getPaperRight();
            if (StrUtil.isNotBlank(paperRight)) {
                Map<Integer, JSONObject> reportRightMap = JSON.parseObject(paperRight, new TypeReference<Map<Integer, JSONObject>>() {
                });

                return reportRightMap.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(entry -> {
                    Integer key = entry.getKey();
                    JSONObject value = entry.getValue();
                    if (Objects.nonNull(key)) {
                        value.put("referCount", key);
                    }
                    return value;
                }).collect(Collectors.toList());
            }
        }   
        
        return new ArrayList<>();
    }

    @Override
    public void executeMode(String id, String clickMode, long userId, String token) {

        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.nonNull(condition)) {

            if (StrUtil.isNotBlank(clickMode) && clickMode.equals("0")) {
                ReportContent reportContent = new ReportContent();
                reportContent.setId(id);
                reportContent.setClickMode(clickMode);
                reportContent.setModeIng("");
                reportContent.setCompleteness(0);
                reportContent.setUserId(userId);

                Question question = mongoTemplate.findById(id, Question.class);
                if (Objects.nonNull(question)) {
                    String name = question.getName();
                    reportContent.setTitle(name);
                } else {
                    reportContent.setTitle("");
                }
                reportContent.setReportCreate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
                reportContent.setTimeStamp(LocalDateTime.now().toEpochSecond(ZoneOffset.UTC));
                mongoTemplate.save(reportContent);

                ExecutorService executorService = Executors.newFixedThreadPool(1);

                CompletableFuture.runAsync(() -> {
                    List<String> template = createReportTemplate(id, "后台", userId, null);
                    GenTemplateRequest genTemplateRequest = new GenTemplateRequest(id, "pc");
                    fillTemplate(genTemplateRequest, userId, token, null);
                }, executorService);
            }
        }   
    }

    @Override
    public PageVo<ClickReportResponse> searchClickStatus(long userId, Integer pageSize, Integer pageNum) {
        List<ClickReportResponse> downList = new ArrayList<>();
        Query query = new Query();
        query.addCriteria(Criteria.where("userId").is(userId).and("delete").is("0").and("clickMode").is("0"));
        long allClickReport = mongoTemplate.count(query, ReportContent.class);

        query.with(PageRequest.of(pageNum - 1, pageSize));
        query.with(Sort.by(Sort.Order.desc("timeStamp")));
        List<ReportContent> reportContents = mongoTemplate.find(query, ReportContent.class);
        if (CollUtil.isNotEmpty(reportContents)) {
            reportContents.forEach(reportContent -> {
                ClickReportResponse clickReportResponse = new ClickReportResponse();
                clickReportResponse.setId(reportContent.getId());
                clickReportResponse.setTitle(reportContent.getTitle());
                clickReportResponse.setReportCreate(reportContent.getReportCreate());
                Integer completeness = reportContent.getCompleteness();
                switch (completeness) {
                    case -1:
                        clickReportResponse.setStatus("生成中断");
                        break;
                    case 0:
                        clickReportResponse.setStatus("正在生成中");
                        clickReportResponse.setModIng(reportContent.getModeIng());
                        break;
                    case 1:
                        clickReportResponse.setStatus("已完成");
                        break;
                    default:
                        clickReportResponse.setStatus("生成中断");
                        break;
                }
                downList.add(clickReportResponse);
            });
        }

        PageVo<ClickReportResponse> response = new PageVo<>();
        response.setList(downList);
        response.setPageNum(pageNum);
        response.setPageSize(pageSize);
        response.setPages((int) Math.ceil(allClickReport / (double) pageSize));
        response.setTotal(allClickReport);
        return response;
    }

    @Override
    public void deleteClickReport(long userId, String id, String allD) {
        if ("true".equals(allD)) {
            Query query = new Query(Criteria.where("userId").is(userId));
            
            List<ReportContent> reportContents = mongoTemplate.find(query, ReportContent.class);
            
            if (CollUtil.isNotEmpty(reportContents)) {
                Update update = new Update();
                update.set("delete", 1);
                mongoTemplate.updateMulti(query, update, ReportContent.class);
                return;
            }
        } 
        if (StrUtil.isNotBlank(id)) {
            ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
            if (Objects.nonNull(reportContent)) {
                Update update = new Update();
                update.set("delete", 1);
                mongoTemplate.updateFirst(Query.query(Criteria.where("id").is(id)), update, ReportContent.class);
            }
        }
    }

    @Override
    public String updateClickStatus(long userId, String id) {
        Query query = new Query();
        query.addCriteria(Criteria.where("userId").is(userId).and("id").is(id));
        ReportContent reportContent = mongoTemplate.findOne(query, ReportContent.class);
        if (Objects.nonNull(reportContent)) {
            Integer completeness = reportContent.getCompleteness();
            if (completeness == -1 || completeness == 0 || completeness == 1) {
                return String.valueOf(reportContent.getCompleteness());
            } else {
                return String.valueOf(-1);
            }
        }
        return "-1";
    }

    @Override
    public void downloadWord(String id, String source, HttpServletResponse response) {
        ReportContent reportContent = mongoTemplate.findById(id, ReportContent.class);
        response.setHeader("Content-Disposition", "attachment;fileName=" + "fileName" + ".doc");

        if (Objects.nonNull(reportContent)) {
            try {
                // 创建Word文档
                XWPFDocument document = new XWPFDocument();
                // 添加页眉设置（仅右上角Logo）
                setDocumentHeaderWithLogo(document);
                MutableDataSet options = new MutableDataSet();
                // 启用表格扩展
                options.set(Parser.EXTENSIONS, Arrays.asList(TablesExtension.create()));
                
                Parser parser = Parser.builder(options).build();
                HtmlRenderer renderer = HtmlRenderer.builder(options).build();

                List<String> toWord = reportContent.getToWord();

                String wordHtml = reportContent.getWordHtml();
                if (StrUtil.isNotBlank(wordHtml)) {
                    // 解析HTML
                    Document doc = Jsoup.parse(wordHtml);
                    // 处理HTML元素并添加到Word文档
                    processHtmlElements(doc.body(), document);

                    genWord(source, response, document);
                    return;
                }

                if (CollUtil.isNotEmpty(toWord)) {
                    // 添加封面
                    insertCover(reportContent, source, document);

                    // 添加分页符，开辟新页面
                    XWPFParagraph paragraph = document.createParagraph();
                    XWPFRun run = paragraph.createRun();
                    run.addBreak(BreakType.PAGE); // 分页符

                    for (String beConverted : toWord) {
                        if (beConverted == null || beConverted.trim().isEmpty()) {
                            continue;
                        }
                        log.info("Processing markdown content:{} ", beConverted.substring(0, Math.min(100, beConverted.length())) + "...");

                        // 检查是否包含表格
                        if (beConverted.contains("|")) {
                            // 直接处理Markdown表格
                            processMarkdownTable(beConverted, document);
                        } else {
                            // 将Markdown转换为HTML
                            Node document1 = parser.parse(beConverted);
                            String html = renderer.render(document1);

                            // 解析HTML
                            Document doc = Jsoup.parse(html);

                            // 处理HTML元素并添加到Word文档
                            processHtmlElements(doc.body(), document);
                        }
                    }
                    genWord(source, response, document);
                } else {
                    response.setStatus(HttpServletResponse.SC_OK);
                    try {
                        response.getWriter().write("报告内容不存在。");
                    } catch (IOException e) {
                        log.error("写入 404 错误信息失败: {}", e.getMessage(), e);
                    }
                }

            } catch (Exception e) {
                log.error("下载 Word 文档失败: {}", e.getMessage(), e);
                response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
                try {
                    response.getWriter().write("下载失败，请稍后再试。");
                } catch (IOException ioException) {
                    log.error("写入错误信息失败: {}", ioException.getMessage(), ioException);
                }
            }
        } else {
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            try {
                response.getWriter().write("报告内容不存在。");
            } catch (IOException e) {
                log.error("写入 404 错误信息失败: {}", e.getMessage(), e);
            }
        }
    }
    
    // ######################### 处理html内容 ##################################
    private void processHtmlElements(Element element, XWPFDocument document) {
        Elements children = element.children();

        if (children.isEmpty() && !element.text().trim().isEmpty()) {
            // 处理纯文本
            XWPFParagraph paragraph = document.createParagraph();
            XWPFRun run = paragraph.createRun();
            run.setText(element.text());
            run.setFontFamily("宋体");
            return;
        }

        for (Element child : children) {
            String tagName = child.tagName().toLowerCase();

            switch (tagName) {
                case "h1":
                case "h2":
                case "h3":
                case "h4":
                case "h5":
                case "h6":
                    // 处理标题
                    createHeading(document, child.text(), Integer.parseInt(tagName.substring(1)));
                    break;

                case "p":
                    // 处理段落，支持内部格式化
                    processParagraphWithFormatting(document, child);
                    break;

                case "ul":
                case "ol":
                    // 处理列表
                    processListItems(document, child, tagName.equals("ol"));
                    break;

                case "table":
                    // 处理表格
                    processTable(document, child);
                    break;

                case "blockquote":
                    // 处理引用块
                    XWPFParagraph quoteP = document.createParagraph();
                    quoteP.setBorderLeft(Borders.SINGLE);
                    quoteP.setIndentationLeft(720); // 缩进0.5英寸 (720 twips)
                    XWPFRun quoteRun = quoteP.createRun();
                    quoteRun.setText(child.text());
                    quoteRun.setItalic(true);
                    quoteRun.setColor("666666");
                    break;

                default:
                    // 递归处理其他元素
                    processHtmlElements(child, document);
                    break;
            }
        }
    }

    // ######################### 处理p标签 ##################################

    /**
     * 处理带有格式化的段落
     */
    private void processParagraphWithFormatting(XWPFDocument document, Element pElement) {
        // 跳过空段落
        if (pElement.text().trim().isEmpty()) {
            return;
        }

        XWPFParagraph paragraph = document.createParagraph();
        paragraph.setIndentationFirstLine(2 * 240); // 首行缩进

        // 递归处理段落内的所有节点
        processChildNodes(paragraph, pElement);
    }

    /**
     * 递归处理子节点
     */
    private void processChildNodes(XWPFParagraph paragraph, Element parentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                // 处理纯文本节点
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setText(text);
                }
            } else if (node instanceof Element) {
                // 处理HTML元素节点
                Element element = (Element) node;
                processInlineElement(paragraph, element);
            }
        }
    }

    /**
     * 处理行内元素
     */
    private void processInlineElement(XWPFParagraph paragraph, Element element) {
        String tagName = element.tagName().toLowerCase();

        switch (tagName) {
            case "span":
                processSpanElement(paragraph, element);
                break;
            case "strong":
            case "b":
                processStrongElement(paragraph, element);
                break;
            case "em":
            case "i":
                processEmElement(paragraph, element);
                break;
            case "u":
                processUnderlineElement(paragraph, element);
                break;
            case "sup":
                processSupElement(paragraph, element);
                break;
            case "sub":
                processSubElement(paragraph, element);
                break;
            case "mark":
                processMarkElement(paragraph, element);
                break;
            default:
                // 对于其他标签，递归处理其子节点
                processChildNodes(paragraph, element);
                break;
        }
    }

    /**
     * 处理span元素
     */
    private void processSpanElement(XWPFParagraph paragraph, Element spanElement) {
        // 如果span有子节点，递归处理
        if (spanElement.childNodeSize() > 0) {
            processChildNodesWithStyle(paragraph, spanElement);
        } else {
            // 如果是叶子节点，创建run并应用样式
            String text = spanElement.text();
            if (!text.trim().isEmpty()) {
                XWPFRun run = paragraph.createRun();
                run.setFontFamily("宋体");
                run.setFontSize(12);
                run.setText(text);
                applyInlineStyles(run, spanElement);
            }
        }
    }

    /**
     * 处理带样式的子节点
     */
    private void processChildNodesWithStyle(XWPFParagraph paragraph, Element parentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setText(text);
                    applyInlineStyles(run, parentElement);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                // 继承父元素样式并处理子元素
                processInlineElementWithInheritedStyle(paragraph, childElement, parentElement);
            }
        }
    }

    /**
     * 处理带继承样式的行内元素（改进版）
     */
    private void processInlineElementWithInheritedStyle(XWPFParagraph paragraph, Element element, Element parentElement) {
        // 如果元素有子节点，需要递归处理，而不是简单取text()
        if (element.childNodeSize() > 0) {
            // 递归处理子节点，传递父元素样式
            processChildNodesWithInheritedStyles(paragraph, element, parentElement);
        } else {
            // 叶子节点，直接处理文本
            String text = element.text();
            if (!text.trim().isEmpty()) {
                XWPFRun run = paragraph.createRun();
                run.setFontFamily("宋体");
                run.setFontSize(12);
                run.setText(text);

                // 先应用父元素样式
                applyInlineStyles(run, parentElement);
                applyTagSpecificStyles(run, parentElement);

                // 再应用当前元素样式
                applyInlineStyles(run, element);
                applyTagSpecificStyles(run, element);
            }
        }
    }

    /**
     * 处理带继承样式的子节点
     */
    private void processChildNodesWithInheritedStyles(XWPFParagraph paragraph, Element parentElement, Element grandParentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setText(text);

                    // 应用祖父元素样式
                    if (grandParentElement != null) {
                        applyInlineStyles(run, grandParentElement);
                        applyTagSpecificStyles(run, grandParentElement);
                    }

                    // 应用父元素样式
                    applyInlineStyles(run, parentElement);
                    applyTagSpecificStyles(run, parentElement);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                String tagName = childElement.tagName().toLowerCase();

                // 根据子元素类型进行特殊处理
                switch (tagName) {
                    case "sup":
                        processSupElementWithInheritedStyles(paragraph, childElement, parentElement, grandParentElement);
                        break;
                    case "mark":
                        processMarkElementWithInheritedStyles(paragraph, childElement, parentElement, grandParentElement);
                        break;
                    case "strong":
                    case "b":
                        processStrongElementWithInheritedStyles(paragraph, childElement, parentElement, grandParentElement);
                        break;
                    case "em":
                    case "i":
                        processEmElementWithInheritedStyles(paragraph, childElement, parentElement, grandParentElement);
                        break;
                    default:
                        // 其他元素，递归处理
                        processGenericElementWithInheritedStyles(paragraph, childElement, parentElement, grandParentElement);
                        break;
                }
            }
        }
    }

    /**
     * 处理带继承样式的上标元素
     */
    private void processSupElementWithInheritedStyles(XWPFParagraph paragraph, Element supElement,
                                                      Element parentElement, Element grandParentElement) {
        // 处理上标的子节点
        for (org.jsoup.nodes.Node node : supElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(10);
                    run.setSubscript(VerticalAlign.SUPERSCRIPT);
                    run.setText(text);

                    // 继承样式链
                    if (grandParentElement != null) {
                        applyInlineStyles(run, grandParentElement);
                        applyTagSpecificStyles(run, grandParentElement);
                    }
                    if (parentElement != null) {
                        applyInlineStyles(run, parentElement);
                        applyTagSpecificStyles(run, parentElement);
                    }
                    // 应用自身样式
                    applyInlineStyles(run, supElement);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                if ("mark".equals(childElement.tagName().toLowerCase())) {
                    // 上标中的高亮文本
                    String text = childElement.text();
                    if (!text.trim().isEmpty()) {
                        XWPFRun run = paragraph.createRun();
                        run.setFontFamily("宋体");
                        run.setFontSize(10);
                        run.setSubscript(VerticalAlign.SUPERSCRIPT);
                        run.setText(text);

                        // 继承样式链
                        if (grandParentElement != null) {
                            applyInlineStyles(run, grandParentElement);
                            applyTagSpecificStyles(run, grandParentElement);
                        }
                        if (parentElement != null) {
                            applyInlineStyles(run, parentElement);
                            applyTagSpecificStyles(run, parentElement);
                        }
                        // 应用上标样式
                        applyInlineStyles(run, supElement);
                        // 应用高亮样式
                        applyHighlightStyle(run, childElement);
                    }
                }
            }
        }
    }

    /**
     * 处理带继承样式的高亮元素
     */
    private void processMarkElementWithInheritedStyles(XWPFParagraph paragraph, Element markElement,
                                                       Element parentElement, Element grandParentElement) {
        String text = markElement.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(12);
            run.setText(text);

            // 继承样式链
            if (grandParentElement != null) {
                applyInlineStyles(run, grandParentElement);
                applyTagSpecificStyles(run, grandParentElement);
            }
            if (parentElement != null) {
                applyInlineStyles(run, parentElement);
                applyTagSpecificStyles(run, parentElement);
            }
            // 应用高亮样式
            applyHighlightStyle(run, markElement);
        }
    }

    /**
     * 处理带继承样式的粗体元素
     */
    private void processStrongElementWithInheritedStyles(XWPFParagraph paragraph, Element strongElement,
                                                         Element parentElement, Element grandParentElement) {
        String text = strongElement.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(12);
            run.setBold(true);
            run.setText(text);

            // 继承样式链
            if (grandParentElement != null) {
                applyInlineStyles(run, grandParentElement);
                applyTagSpecificStyles(run, grandParentElement);
            }
            if (parentElement != null) {
                applyInlineStyles(run, parentElement);
                applyTagSpecificStyles(run, parentElement);
            }
            // 应用自身样式
            applyInlineStyles(run, strongElement);
        }
    }

    /**
     * 处理带继承样式的斜体元素
     */
    private void processEmElementWithInheritedStyles(XWPFParagraph paragraph, Element emElement,
                                                     Element parentElement, Element grandParentElement) {
        // 如果em元素有子节点，需要递归处理
        if (emElement.childNodeSize() > 0) {
            processChildNodesWithEmAndInheritedStyles(paragraph, emElement, parentElement, grandParentElement);
        } else {
            String text = emElement.text();
            if (!text.trim().isEmpty()) {
                XWPFRun run = paragraph.createRun();
                run.setFontFamily("宋体");
                run.setFontSize(12);
                run.setItalic(true);
                run.setText(text);

                // 继承样式链
                if (grandParentElement != null) {
                    applyInlineStyles(run, grandParentElement);
                    applyTagSpecificStyles(run, grandParentElement);
                }
                if (parentElement != null) {
                    applyInlineStyles(run, parentElement);
                    applyTagSpecificStyles(run, parentElement);
                }
                // 应用自身样式
                applyInlineStyles(run, emElement);
            }
        }
    }

    /**
     * 处理em元素的子节点并继承样式
     */
    private void processChildNodesWithEmAndInheritedStyles(XWPFParagraph paragraph, Element emElement,
                                                           Element parentElement, Element grandParentElement) {
        for (org.jsoup.nodes.Node node : emElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setItalic(true);
                    run.setText(text);

                    // 继承样式链
                    if (grandParentElement != null) {
                        applyInlineStyles(run, grandParentElement);
                        applyTagSpecificStyles(run, grandParentElement);
                    }
                    if (parentElement != null) {
                        applyInlineStyles(run, parentElement);
                        applyTagSpecificStyles(run, parentElement);
                    }
                    applyInlineStyles(run, emElement);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                String tagName = childElement.tagName().toLowerCase();

                switch (tagName) {
                    case "sup":
                        processSupElementWithInheritedStyles(paragraph, childElement, emElement, parentElement);
                        break;
                    case "mark":
                        processMarkElementWithInheritedStyles(paragraph, childElement, emElement, parentElement);
                        break;
                    default:
                        // 其他子元素
                        String text = childElement.text();
                        if (!text.trim().isEmpty()) {
                            XWPFRun run = paragraph.createRun();
                            run.setFontFamily("宋体");
                            run.setFontSize(12);
                            run.setItalic(true);
                            run.setText(text);

                            // 继承样式链
                            if (grandParentElement != null) {
                                applyInlineStyles(run, grandParentElement);
                                applyTagSpecificStyles(run, grandParentElement);
                            }
                            if (parentElement != null) {
                                applyInlineStyles(run, parentElement);
                                applyTagSpecificStyles(run, parentElement);
                            }
                            applyInlineStyles(run, emElement);
                            applyInlineStyles(run, childElement);
                            applyTagSpecificStyles(run, childElement);
                        }
                        break;
                }
            }
        }
    }

    /**
     * 处理带继承样式的通用元素
     */
    private void processGenericElementWithInheritedStyles(XWPFParagraph paragraph, Element element,
                                                          Element parentElement, Element grandParentElement) {
        String text = element.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(12);
            run.setText(text);

            // 继承样式链
            if (grandParentElement != null) {
                applyInlineStyles(run, grandParentElement);
                applyTagSpecificStyles(run, grandParentElement);
            }
            if (parentElement != null) {
                applyInlineStyles(run, parentElement);
                applyTagSpecificStyles(run, parentElement);
            }
            // 应用自身样式
            applyInlineStyles(run, element);
            applyTagSpecificStyles(run, element);
        }
    }

    /**
     * 应用行内样式
     */
    private void applyInlineStyles(XWPFRun run, Element element) {
        String style = element.attr("style");
        if (style != null && !style.isEmpty()) {
            // 处理字体大小
            String fontSize = extractStyleValue(style, "font-size");
            if (fontSize != null) {
                try {
                    int size = Integer.parseInt(fontSize.replaceAll("[^0-9]", ""));
                    run.setFontSize(size);
                } catch (NumberFormatException e) {
                    // 忽略无效的字体大小
                }
            }

            // 处理字体颜色
            String color = extractStyleValue(style, "color");
            if (color != null) {
                String colorHex = color.replace("#", "").toUpperCase();
                if (colorHex.length() == 6) {
                    run.setColor(colorHex);
                }
            }

            // 处理背景色（高亮）
            String backgroundColor = extractStyleValue(style, "background-color");
            if (backgroundColor != null) {
                applyBackgroundColor(run, backgroundColor, element);
            }
        }
    }

    /**
     * 应用标签特定样式
     */
    private void applyTagSpecificStyles(XWPFRun run, Element element) {
        String tagName = element.tagName().toLowerCase();
        switch (tagName) {
            case "strong":
            case "b":
                run.setBold(true);
                break;
            case "em":
            case "i":
                run.setItalic(true);
                break;
            case "u":
                run.setUnderline(UnderlinePatterns.SINGLE);
                break;
            case "sup":
                run.setSubscript(VerticalAlign.SUPERSCRIPT);
                break;
            case "sub":
                run.setSubscript(VerticalAlign.SUBSCRIPT);
                break;
        }
    }


    /**
     * 应用背景色/高亮色
     */
    private static void applyBackgroundColor(XWPFRun run, String backgroundColor, Element element) {
        // 优先使用 data-color 属性
        String dataColor = element.attr("data-color");
        String colorToUse = dataColor != null && !dataColor.isEmpty() ? dataColor : backgroundColor;

        // 清理颜色值
        colorToUse = colorToUse.replace("#", "").toUpperCase();

        if (colorToUse.length() == 6) {
            // 根据颜色值映射到Word支持的高亮色
            STHighlightColor.Enum highlightColor = mapColorToHighlight(colorToUse);

            if (highlightColor != null) {
                run.getCTR().addNewRPr().addNewHighlight().setVal(highlightColor);
            } else {
                // 如果无法映射到预定义高亮色，使用字符底纹
                applyCharacterShading(run, colorToUse);
            }
        }
    }



    // ######################### 处理标题 ##################################
    private void createHeading(XWPFDocument document, String text, int level) {
        XWPFParagraph paragraph = document.createParagraph();
        paragraph.setStyle("Heading" + level);
        XWPFRun run = paragraph.createRun();
        run.setText(text);
        run.setFontFamily("宋体");
        run.setBold(true);

        // 根据标题级别设置字体大小
        switch (level) {
            case 1:
                run.setFontSize(20);
                paragraph.setAlignment(ParagraphAlignment.CENTER);
                break;
            case 2: run.setFontSize(18); break;
            case 3: run.setFontSize(16); break;
            case 4: run.setFontSize(14); break;
            case 5: run.setFontSize(12); break;
            case 6: run.setFontSize(11); break;
        }
    }



    // ######################### markdown表格 ##################################
    private void processMarkdownTable(String markdownContent, XWPFDocument document) {
        String[] lines = markdownContent.split("\n");

        int currentLineIndex = 0;

        while (currentLineIndex < lines.length) {
            // Find the next table start
            int tableStartIndex = -1;
            int tableEndIndex = -1;

            // Search for table from the current position
            for (int i = currentLineIndex; i < lines.length; i++) {
                String line = lines[i].trim();
                if (line.startsWith("|") && line.endsWith("|")) {
                    if (tableStartIndex == -1) {
                        tableStartIndex = i;
                    }
                    tableEndIndex = i;
                } else if (tableStartIndex != -1 && !line.startsWith("|")) {
                    // Table has ended
                    break;
                }
            }

            if (tableStartIndex != -1 && tableEndIndex != -1) {
                // Process content before the table
                for (int i = currentLineIndex; i < tableStartIndex; i++) {
                    if (!lines[i].trim().isEmpty()) {
                        processNonTableContent(lines[i], document);
                    }
                }

                // Process the table
                createTableFromMarkdown(lines, tableStartIndex, tableEndIndex, document);

                // Update current position to continue after this table
                currentLineIndex = tableEndIndex + 1;
            } else {
                // No more tables found, process remaining content
                for (int i = currentLineIndex; i < lines.length; i++) {
                    if (!lines[i].trim().isEmpty()) {
                        processNonTableContent(lines[i], document);
                    }
                }
                break;
            }
        }
    }
    
    // ######################### 生成封面 ##################################
    private void insertCover(ReportContent reportContent, String source, XWPFDocument document) {
        XWPFParagraph coverParagraph = document.createParagraph();
        XWPFRun titleRun = coverParagraph.createRun();

        addEmptyLines(titleRun, 3);

        titleRun.setText(reportContent.getTitle());
        titleRun.setFontSize(24);
        titleRun.setBold(true);
        titleRun.setFontFamily("宋体");
        coverParagraph.setAlignment(ParagraphAlignment.CENTER);


        if ("app".equals(source)) {
            addEmptyLines(titleRun, 8);
            XWPFRun conRun = coverParagraph.createRun();
            conRun.setFontSize(12);
            conRun.setText("灵犀量子（北京）医疗科技有限公司");
            conRun.setFontFamily("宋体");

            addEmptyLines(titleRun, 1);
            LocalDate now = LocalDate.now();
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
            String format = formatter.format(now);
            conRun.setText(format);

            addEmptyLines(titleRun, 1);
            conRun.setText("本报告包含由 EviMed 模型 AI 生成的内容");
        } else {
            addEmptyLines(titleRun, 12);
            XWPFRun conRun = coverParagraph.createRun();
            conRun.setFontSize(12);
            conRun.setText("灵犀量子（北京）医疗科技有限公司");
            conRun.setFontFamily("宋体");

            addEmptyLines(conRun, 1);
            LocalDate now = LocalDate.now();
            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
            String format = formatter.format(now);
            conRun.setText(format);

            addEmptyLines(conRun, 1);
            conRun.setText("本报告包含由 EviMed 模型 AI 生成的内容");
        }

    }

    // ######################### 下载word ##################################
    private static void genWord(String source, HttpServletResponse response, XWPFDocument document) throws IOException {
        // 设置响应头，触发浏览器下载
        String fileName = source + ".docx";
        fileName = URLEncoder.encode(fileName, "UTF-8");
        response.setContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + fileName + "; filename*=UTF-8''" + fileName);

        // 将 Word 文档写入响应输出流
        try (ServletOutputStream out = response.getOutputStream()) {
            document.write(out);
        }
    }












    @Override
    public void editMultiContent(EditMultiContentRequest editMultiContentRequest, long userId, String token, HttpServletResponse response) {

        Integer type = editMultiContentRequest.getType();
        String content = editMultiContentRequest.getContent();

        if (Objects.isNull(type) || StrUtil.isBlank(content)) {
            try {
                response.getWriter().write("event : END" +"\n");
                response.getWriter().write("data: [END]" + "\n\n");
                response.getWriter().flush();
            } catch (IOException e) {
                log.error("Error occurred: " + e.getMessage());
            }
        }

        final String threadRequestId = UUID.randomUUID().toString();
        // 注册响应对象
        ResponseRegistry.register(threadRequestId, response);
        
        try (Response responseResult = pharmacyFeign.edit(editMultiContentRequest)) {
            Response.Body body = responseResult.body();
            InputStream inputStream = body.asInputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                if (StringUtils.isNotBlank(line) && Objects.nonNull(response)) {
                    write(line, threadRequestId);
                    System.out.println(line);
                }
            }
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
    }

    /**
     * 设置文档页眉，在右上角添加Logo
     * @param document Word文档对象
     */
    private void setDocumentHeaderWithLogo(XWPFDocument document) {
        try {
            //修改页边距
            CTSectPr sectPr = document.getDocument().getBody().addNewSectPr();
            CTPageMar pageMar = sectPr.addNewPgMar();
            pageMar.setLeft(BigInteger.valueOf(1440));
            pageMar.setRight(BigInteger.valueOf(1440));
            pageMar.setTop(BigInteger.valueOf(1440));
            pageMar.setBottom(BigInteger.valueOf(1440));

            // 创建页眉页脚策略
            XWPFHeaderFooterPolicy headerFooterPolicy = document.createHeaderFooterPolicy();
            // 创建页眉
            XWPFHeader header = headerFooterPolicy.createHeader(XWPFHeaderFooterPolicy.DEFAULT);
            // 在页眉中添加一个段落
            XWPFParagraph headerParagraph = header.createParagraph();
            headerParagraph.setAlignment(ParagraphAlignment.RIGHT); // 右对齐
            // 在段落中添加文字
            XWPFRun run = headerParagraph.createRun();
            // 从资源文件加载Logo图片
            InputStream imageStream = getClass().getResourceAsStream("/image/lingxi.jpg");
            if (imageStream != null) {
                // 插入图片并设置大小
                run.addPicture(
                        imageStream,
                        XWPFDocument.PICTURE_TYPE_JPEG,  
                        "lingxi",
                        Units.toEMU(100),   
                        Units.toEMU(30)   
                );
                imageStream.close();
            } else {
                log.error("Logo图片未找到: /image/logo.jpg");
            }
        } catch (Exception e) {
            log.error("设置页眉Logo失败: {}", e.getMessage());
        }
    }
    

    private void processNonTableContent(String content, XWPFDocument document) {
        try {
            MutableDataSet options = new MutableDataSet();
            options.set(Parser.EXTENSIONS, Arrays.asList(TablesExtension.create()));

            Parser parser = Parser.builder(options).build();
            HtmlRenderer renderer = HtmlRenderer.builder(options).build();

            Node documentNode = parser.parse(content);
            String html = renderer.render(documentNode);

            Document doc = Jsoup.parse(html);
            processHtmlElements(doc.body(), document);
        } catch (Exception e) {
            // 如果处理失败，作为普通文本处理
            XWPFParagraph paragraph = document.createParagraph();
            XWPFRun run = paragraph.createRun();
            run.setText(content);
            run.setFontFamily("宋体");
        }
    }

    private void createTableFromMarkdown(String[] lines, int startIndex, int endIndex, XWPFDocument document) {
        try {
            // 解析表格数据
            String[][] tableData = parseMarkdownTable(lines, startIndex, endIndex);

            if (tableData.length == 0) {
                return;
            }

            // 创建Word表格
            XWPFTable table = document.createTable(tableData.length, tableData[0].length);

            // 设置表格样式
            table.setWidth("100%");
            table.setTableAlignment(TableRowAlign.CENTER);

            // 填充表格数据
            for (int i = 0; i < tableData.length; i++) {
                XWPFTableRow row = table.getRow(i);

                for (int j = 0; j < tableData[i].length; j++) {
                    XWPFTableCell cell = row.getCell(j);
                    if (cell == null) {
                        cell = row.createCell();
                    }

                    // 清除默认段落
                    cell.removeParagraph(0);

                    // 创建新段落
                    XWPFParagraph paragraph = cell.addParagraph();
                    paragraph.setAlignment(ParagraphAlignment.LEFT);

                    XWPFRun run = paragraph.createRun();
                    run.setText(tableData[i][j]);
                    run.setFontSize(10);
                    run.setFontFamily("宋体");

                    // 如果是表头行，设置为粗体
                    if (i == 0) {
                        run.setBold(true);
                        cell.setColor("F2F2F2"); // 浅灰色背景
                    }

                    // 设置单元格边框
                    cell.getCTTc().addNewTcPr().addNewTcBorders();

                    // 设置单元格内边距
                    cell.setVerticalAlignment(XWPFTableCell.XWPFVertAlign.CENTER);
                }
            }

            log.info("成功创建表格，行数: {}，列数: {}", tableData.length, tableData[0].length);

        } catch (Exception e) {
           log.error("创建表格时出错:{} ", e.getMessage(), e);
        }
    }

    private String[][] parseMarkdownTable(String[] lines, int startIndex, int endIndex) {
        List<String[]> rows = new ArrayList<>();

        for (int i = startIndex; i <= endIndex; i++) {
            String line = lines[i].trim();

            // 跳过分隔行（如 |---|---|---|）
            if (line.matches("\\|[\\s\\-\\|:]*\\|")) {
                continue;
            }

            if (line.startsWith("|") && line.endsWith("|")) {
                // 移除首尾的 |，然后按 | 分割
                line = line.substring(1, line.length() - 1);
                String[] cells = line.split("\\|");

                // 清理每个单元格的内容
                for (int j = 0; j < cells.length; j++) {
                    cells[j] = cleanCellContent(cells[j].trim());
                }

                rows.add(cells);
            }
        }

        return rows.toArray(new String[0][]);
    }

    private String cleanCellContent(String content) {
        if (content == null) {
            return "";
        }

        // 移除HTML标签（如 <sup>）
        content = content.replaceAll("<[^>]+>", "");

        // 处理特殊字符
        content = content.replace("&nbsp;", " ");
        content = content.replace("&lt;", "<");
        content = content.replace("&gt;", ">");
        content = content.replace("&amp;", "&");

        return content.trim();
    }


   

   

    

   

    

   

    /**
     * 处理strong元素
     */
    private void processStrongElement(XWPFParagraph paragraph, Element strongElement) {
        processChildNodesWithBold(paragraph, strongElement);
    }

    /**
     * 处理带粗体的子节点
     */
    private void processChildNodesWithBold(XWPFParagraph paragraph, Element parentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setBold(true);
                    run.setText(text);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                String text = childElement.text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setBold(true);
                    run.setText(text);
                    applyTagSpecificStyles(run, childElement);
                }
            }
        }
    }

    /**
     * 处理em元素
     */
    private void processEmElement(XWPFParagraph paragraph, Element emElement) {
        String text = emElement.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(12);
            run.setItalic(true);
            run.setText(text);
        }
    }

    /**
     * 处理下划线元素
     */
    private void processUnderlineElement(XWPFParagraph paragraph, Element uElement) {
        String text = uElement.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(12);
            run.setUnderline(UnderlinePatterns.SINGLE);
            run.setText(text);
        }
    }

    /**
     * 处理上标元素
     */
    private void processSupElement(XWPFParagraph paragraph, Element supElement) {
        // 处理上标内的内容，可能包含mark等元素
        if (supElement.childNodeSize() > 0) {
            processChildNodesWithSuperscript(paragraph, supElement);
        } else {
            String text = supElement.text();
            if (!text.trim().isEmpty()) {
                XWPFRun run = paragraph.createRun();
                run.setFontFamily("宋体");
                run.setFontSize(10); // 上标字体稍小
                run.setSubscript(VerticalAlign.SUPERSCRIPT);
                run.setText(text);
            }
        }
    }

    /**
     * 处理带上标的子节点
     */
    private void processChildNodesWithSuperscript(XWPFParagraph paragraph, Element parentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(10);
                    run.setSubscript(VerticalAlign.SUPERSCRIPT);
                    run.setText(text);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                String text = childElement.text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(10);
                    run.setSubscript(VerticalAlign.SUPERSCRIPT);
                    run.setText(text);

                    // 应用子元素特定样式（如高亮）
                    applyTagSpecificStyles(run, childElement);
                    applyInlineStyles(run, childElement);
                }
            }
        }
    }

    /**
     * 处理下标元素
     */
    private void processSubElement(XWPFParagraph paragraph, Element subElement) {
        String text = subElement.text();
        if (!text.trim().isEmpty()) {
            XWPFRun run = paragraph.createRun();
            run.setFontFamily("宋体");
            run.setFontSize(10);
            run.setSubscript(VerticalAlign.SUBSCRIPT);
            run.setText(text);
        }
    }

    /**
     * 处理带高亮的子节点
     */
    private void processChildNodesWithHighlight(XWPFParagraph paragraph, Element parentElement) {
        for (org.jsoup.nodes.Node node : parentElement.childNodes()) {
            if (node instanceof TextNode) {
                String text = ((TextNode) node).text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setText(text);
                    applyHighlightStyle(run, parentElement);
                }
            } else if (node instanceof Element) {
                Element childElement = (Element) node;
                String text = childElement.text();
                if (!text.trim().isEmpty()) {
                    XWPFRun run = paragraph.createRun();
                    run.setFontFamily("宋体");
                    run.setFontSize(12);
                    run.setText(text);

                    // 应用高亮样式
                    applyHighlightStyle(run, parentElement);
                    // 应用子元素特定样式
                    applyTagSpecificStyles(run, childElement);
                }
            }
        }
    }

    
   
    /**
     * 将颜色值映射到Word支持的高亮色
     */
    private static STHighlightColor.Enum mapColorToHighlight(String colorHex) {
        switch (colorHex.toUpperCase()) {
            case "FFFF00": // 黄色
            case "FFFF99":
                return STHighlightColor.YELLOW;
            case "00FF00": // 绿色
            case "90EE90":
            case "ACD78E":
                return STHighlightColor.GREEN;
            case "FF0000": // 红色
            case "E54C5E":
            case "EF949E": // 您示例中的颜色
                return STHighlightColor.RED;
            case "0000FF": // 蓝色
            case "87CEEB":
                return STHighlightColor.BLUE;
            case "FFA500": // 橙色
            case "FFB366":
                return STHighlightColor.DARK_YELLOW;
            case "FFC0CB": // 粉色
            case "FFB6C1":
                return STHighlightColor.MAGENTA;
            case "800080": // 紫色
            case "9370DB":
                return STHighlightColor.DARK_MAGENTA;
            case "808080": // 灰色
            case "C0C0C0":
                return STHighlightColor.DARK_GRAY;
            case "7DDFD7": // 青色
            case "00FFFF":
                return STHighlightColor.CYAN;
            default:
                // 根据颜色亮度选择最接近的颜色
                return getClosestHighlightColor(colorHex);
        }
    }

    /**
     * 根据颜色值获取最接近的高亮色
     */
    private static STHighlightColor.Enum getClosestHighlightColor(String colorHex) {
        try {
            // 解析RGB值
            int r = Integer.parseInt(colorHex.substring(0, 2), 16);
            int g = Integer.parseInt(colorHex.substring(2, 4), 16);
            int b = Integer.parseInt(colorHex.substring(4, 6), 16);

            // 根据RGB值判断主色调
            if (r > g && r > b) {
                // 红色系
                if (r > 200) {
                    return STHighlightColor.RED;
                } else {
                    return STHighlightColor.DARK_RED;
                }
            } else if (g > r && g > b) {
                // 绿色系
                if (g > 200) {
                    return STHighlightColor.GREEN;
                } else {
                    return STHighlightColor.DARK_GREEN;
                }
            } else if (b > r && b > g) {
                // 蓝色系
                if (b > 200) {
                    return STHighlightColor.BLUE;
                } else {
                    return STHighlightColor.DARK_BLUE;
                }
            } else {
                // 灰色系或混合色
                int avg = (r + g + b) / 3;
                if (avg > 180) {
                    return STHighlightColor.YELLOW; // 亮色用黄色
                } else {
                    return STHighlightColor.DARK_GRAY; // 暗色用灰色
                }
            }
        } catch (Exception e) {
            // 解析失败，返回默认黄色
            return STHighlightColor.YELLOW;
        }
    }

    /**
     * 应用字符底纹（当高亮色无法满足需求时）
     */
    private static void applyCharacterShading(XWPFRun run, String colorHex) {
        try {
            // 创建字符底纹
            CTRPr rPr = run.getCTR().isSetRPr() ? run.getCTR().getRPr() : run.getCTR().addNewRPr();

            // 直接添加新的底纹，如果已存在会被替换
            CTShd shd = rPr.addNewShd();

            // 设置底纹颜色
            shd.setFill(colorHex);
            shd.setVal(STShd.CLEAR);

            // 设置前景色为自动（保持文字颜色不变）
            shd.setColor("auto");

        } catch (Exception e) {
            System.out.println("应用字符底纹失败，使用默认高亮: " + e.getMessage());
            // 失败时使用默认高亮
            try {
                CTRPr rPr = run.getCTR().isSetRPr() ? run.getCTR().getRPr() : run.getCTR().addNewRPr();
                rPr.addNewHighlight().setVal(STHighlightColor.YELLOW);
            } catch (Exception ex) {
                // 如果连默认高亮都失败了，就忽略
                System.out.println("应用默认高亮也失败了: " + ex.getMessage());
            }
        }
    }

    /**
     * 改进的高亮样式应用
     */
    private static void applyHighlightStyle(XWPFRun run, Element element) {
        String style = element.attr("style");
        String dataColor = element.attr("data-color");

        // 优先使用 data-color，其次使用 style 中的 background-color
        String colorToUse = null;

        if (dataColor != null && !dataColor.isEmpty()) {
            colorToUse = dataColor;
        } else if (style != null && style.contains("background-color")) {
            colorToUse = extractStyleValue(style, "background-color");
        }

        if (colorToUse != null) {
            applyBackgroundColor(run, colorToUse, element);
        } else {
            // 默认黄色高亮
            run.getCTR().addNewRPr().addNewHighlight().setVal(STHighlightColor.YELLOW);
        }
    }

    /**
     * 处理高亮标记元素（改进版）
     */
    private void processMarkElement(XWPFParagraph paragraph, Element markElement) {
        // 处理mark内的内容，可能包含sup等元素
        if (markElement.childNodeSize() > 0) {
            processChildNodesWithHighlight(paragraph, markElement);
        } else {
            String text = markElement.text();
            if (!text.trim().isEmpty()) {
                XWPFRun run = paragraph.createRun();
                run.setFontFamily("宋体");
                run.setFontSize(12);
                run.setText(text);
                applyHighlightStyle(run, markElement);
            }
        }
    }

    
    /**
     * 从样式字符串中提取特定样式值
     */
    private static String extractStyleValue(String style, String property) {
        String pattern = property + "\\s*:\\s*([^;]+)";
        Pattern p = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
        Matcher m = p.matcher(style);
        if (m.find()) {
            return m.group(1).trim();
        }
        return null;
    }


    private void processListItems(XWPFDocument document, Element listElement, boolean isOrdered) {
        Elements items = listElement.select("li");
        int itemNum = 1;

        for (Element item : items) {
            XWPFParagraph paragraph = document.createParagraph();
            String ulText = item.text();
            if (!ulText.startsWith("[")) {
                paragraph.setIndentationLeft(720); // 缩进0.5英寸
            }

//            // 设置列表样式
//            if (isOrdered) {
//                paragraph.setNumID(getOrderedListId(document, itemNum));
//            } else {
//                paragraph.setNumID(getBulletListId(document));
//            }

            XWPFRun run = paragraph.createRun();
            run.setText(item.text());
            run.setFontFamily("宋体");
            itemNum++;
        }
    }

    // 这里简化了列表编号处理，实际应用中可能需要更复杂的逻辑
    private BigInteger getOrderedListId(XWPFDocument document, int itemNum) {
        return BigInteger.valueOf(1);
    }

    private BigInteger getBulletListId(XWPFDocument document) {
        return BigInteger.valueOf(2);
    }

    private void processTable(XWPFDocument document, Element tableElement) {
        Elements rows = tableElement.select("tr");
        if (rows.isEmpty()) return;

        // 计算表格列数
        int numCols = 0;
        for (Element row : rows) {
            numCols = Math.max(numCols, row.select("td,th").size());
        }

        if (numCols == 0) return;

        // 创建表格
        XWPFTable table = document.createTable(rows.size(), numCols);
        table.setWidth("100%");

        // 填充表格内容
        for (int i = 0; i < rows.size(); i++) {
            Element row = rows.get(i);
            Elements cells = row.select("td,th");

            for (int j = 0; j < cells.size(); j++) {
                Element cell = cells.get(j);
                XWPFTableCell tableCell = table.getRow(i).getCell(j);

                // 创建单元格内容
                XWPFParagraph paragraph = tableCell.getParagraphArray(0);
                if (paragraph == null) {
                    paragraph = tableCell.addParagraph();
                }

                XWPFRun run = paragraph.createRun();
                run.setText(cell.text());
                run.setFontFamily("宋体");

                // 如果是表头，设置为粗体
                if (cell.tagName().equalsIgnoreCase("th")) {
                    run.setBold(true);
                }
            }
        }
    }

    public void write(String text, String threadRequestId) {
        try {
            // 6. 获取针对该requestId的锁（最小化锁定范围的关键）
            Object lock = responseLocks.computeIfAbsent(threadRequestId, k -> new Object());

            // 7. 仅锁定response写入部分（真正需要互斥的操作）
            synchronized (lock) {
                JSONObject content = JSON.parseObject(text);

                // 通过注册表获取响应对象
                HttpServletResponse response = ResponseRegistry.get(threadRequestId);
                String event = content.getString("event");
                content.remove("event");
                response.getWriter().write("event:"+ event +"\n");
                response.getWriter().write("data:" + content + "\n\n");
                response.getWriter().flush();

//                String event = content.getString("event");
//                String requestId = content.getString("requestId");
//                if (threadRequestId.equals(requestId)) {
//                    content.remove("event");
//                    response.getWriter().write("event:"+ event +"\n");
//                    response.getWriter().write("data:" + content + "\n\n");
//                    response.getWriter().flush();
//                }
            }
         } catch (IOException e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }

    private String verifyTokenValid(String verifyToken) {
        Map<String, Claim> claim = jwtUtils.verifyToken(verifyToken);
        if (MapUtil.isNotEmpty(claim)) {
            Long uid = claim.get("uid").asLong();
            String questionId = claim.get("questionId").asString();
            String token = RedisUtils.getStr(Constants.REPORT_TOKEN + uid + ":" + questionId);
            if (StrUtil.isNotBlank(token)) {
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
            if (StrUtil.isNotBlank(token)) {
                // 删除 token 使其失效
                RedisUtils.del(Constants.REPORT_TOKEN + uid + ":" + questionId);
            }
        }
    }

    // 定义方法
    public void addEmptyLines(XWPFRun run, int lineCount) {
        for (int i = 0; i < lineCount; i++) {
            run.addBreak();
        }
    }
}
