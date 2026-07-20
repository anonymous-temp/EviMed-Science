package com.sentum.service.impl;

import cn.hutool.core.codec.Base64;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.text.UnicodeUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import cn.hutool.http.HttpUtil;
import cn.hutool.poi.excel.ExcelReader;
import cn.hutool.poi.excel.ExcelUtil;
import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.read.metadata.ReadSheet;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.github.rholder.retry.Retryer;
import com.lowagie.text.Font;
import com.lowagie.text.*;
import com.lowagie.text.HeaderFooter;
import com.lowagie.text.Image;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.rtf.RtfWriter2;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.infrastructure.config.ThreadPoolConfig;
import com.sentum.constants.CommonConstants;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.excel.bean.DrugInfoExcelBean;
import com.sentum.excel.listener.DrugInfoImportExcelListener;
import com.sentum.excel.manager.DrugInfoImportManager;
import com.sentum.feign.*;
import com.sentum.feign.FineScreenFeign;
import com.sentum.feign.GetPicoFeign;
import com.sentum.feign.ManageFeign;
import com.sentum.feign.ParingPhraseFeign;
import com.sentum.kafka.KafkaSender;
import com.sentum.pojo.*;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.EvaluationService;
import com.sentum.service.LxGptService;
import com.sentum.service.VaeService;
import com.sentum.util.*;
import com.sentum.util.utilsy.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.poi.hssf.usermodel.*;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.VerticalAlignment;
import org.apache.poi.ss.util.CellRangeAddress;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.script.ScriptType;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.collapse.CollapseBuilder;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;

import javax.servlet.ServletOutputStream;
import javax.servlet.WriteListener;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpServletResponseWrapper;
import java.awt.*;
import java.io.*;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.SimpleDateFormat;
import java.util.List;
import java.util.*;
import java.util.Map.Entry;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.stream.Collectors;

import org.elasticsearch.index.query.TermQueryBuilder;

import static java.awt.Color.GRAY;

/**
 * 综合评价相关实现类
 *
 * @author zgm
 */
@Slf4j
@Service
public class EvaluationServiceImpl implements EvaluationService {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }

    @Value("${evaluation.download.url}")
    private String downloadUrl;

    @Value("${evaluation.title.font.path}")
    private String TITLE_FONT_PATH;


    @Qualifier(ThreadPoolConfig.SU_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor threadPoolTaskExecutor;

    @Autowired
    private MedicineFeign medicineFeign;


    @Qualifier(ThreadPoolConfig.GUIDE_ANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor guideAnalysisThreadPool;

    @Qualifier(ThreadPoolConfig.MAIN_GPTANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor gptAnalysisThreadPool;

    @Autowired
    LxGptService lxGptService;

    @Autowired
    private ManageFeign manageFeign;


    @Autowired
    private KafkaSender kafkaSender;

    @Autowired
    private TraditionalMedicineServiceImpl traditionalMedicineService;

    @Autowired
    private VaeService vaeService;


    @Autowired
    private GptUtil gptUtil;


    HashMap<String, Integer> suMaxMap = new HashMap<String, Integer>() {
        {
            put("安全性", 34);
            put("有效性", 48);
            put("适宜性", 18);
        }
    };
    HashMap<String, Integer> guideMaxMap = new HashMap<String, Integer>() {
        {
            put("安全性", 25);
            put("有效性", 27);
            put("经济性", 10);
            put("药学特性", 28);
            put("其他属性", 10);
        }
    };
    /**
     * 算法分词服务
     */
    @Autowired
    private GetPicoFeign getPicoFeign;
    /**
     * fineScreen服务jieba中文分词服务
     */
    @Autowired
    private FineScreenFeign fineScreenFeign;
    /**
     * 英文分词服务
     */
    @Autowired
    private ParingPhraseFeign paringPhraseFeign;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    private final DrugInfoImportManager drugInfoImportManager;
    RedisTemplate redisTemplate;


    public EvaluationServiceImpl(DrugInfoImportManager drugInfoImportManager, RedisTemplate redisTemplate) {
        this.drugInfoImportManager = drugInfoImportManager;
        this.redisTemplate = redisTemplate;
    }

    // 生成报告的方法，接收药品信息和用户ID等参数，用户ID用于获取封面logo等信息（假设逻辑）
    public void generateReport(HttpServletResponse response, String id) throws IOException, DocumentException {
        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "tr_info_score_v2");

        if (jsonObjects == null) {
            generateReportPc(response, id);
            return;
        }

        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        TrInheritanceEvaluationDto inheritanceEvaluation;
        TrClinicalEvaluationDto clinicalEvaluation;
        TrSafetyEvaluationDto safetyEvaluation;
        TrTechnologyEvaluationDto technologyEvaluation;
        TrMarketEvaluationDto marketEvaluation;
        TrInfoDto trInfoDto = JSONObject.parseObject(jsonObjects.toJSONString(), TrInfoDto.class);
        inheritanceEvaluation = trInfoDto.getTrInheritanceEvaluationDto();
        clinicalEvaluation = trInfoDto.getTrClinicalEvaluationDto();
        safetyEvaluation = trInfoDto.getTrSafetyEvaluationDto();
        technologyEvaluation = trInfoDto.getTrTechnologyEvaluationDto();
        marketEvaluation = trInfoDto.getTrMarketEvaluationDto();
        String drugInfo = trInfoDto.getTitle();

        response.setHeader("Content-Disposition", "attachment;fileName=" + jsonObjects.getString("simpleTitle") + ".doc");
        ServletOutputStream outputStream = response.getOutputStream();
        Document document = new Document();
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        document.open();

        ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
        logo.scaleAbsolute(100, 30);
        logo.setAlignment(Image.ALIGN_RIGHT);

        Paragraph headerParagraph = new Paragraph();
        headerParagraph.add(logo);
        headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

        HeaderFooter header = new HeaderFooter(headerParagraph, false);
        header.setAlignment(HeaderFooter.ALIGN_RIGHT);
        header.setBorderWidth(0);

        document.setHeader(header);

        Paragraph paragraphTitle = createDataWordV1(jsonObjects.getString("simpleTitle"));
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
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
        String formattedDate = sdf.format(calendar.getTime());

        Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
        headWord2.setAlignment(Element.ALIGN_CENTER);
        headWord2.setSpacingBefore(9);
        headWord2.setSpacingAfter(8);
        document.add(headWord2);

        Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
        headWord3.setSpacingBefore(9);
        document.add(headWord3);

        // 新开一页
        document.newPage();

        // 摘要
        Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        document.add(abstractTitle);
        Paragraph abstractContent = new Paragraph("目的 根据《河北省公立医疗机构中成药遴选评价表》对" + drugInfo + "进行临床综合评价。方法 该中成药遴选量表通过对传承评价（22分）、临床评价（25分）、安全评价（20分）、技术评价（14分）及市场评价（19分）5个方面内容，对药品进行临床综合评价归纳总结。结果 根据《河北省公立医疗机构中成药遴选评价表》：" + drugInfo + "最终得分为" + doubleToString(trInfoDto.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(abstractContent);

        // 评价目的
        Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
        // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(purposeTitle);
        Paragraph purposeContent = new Paragraph("本研究通过传承评价、临床评价、安全评价、技术评价以及市场评价5个评价维度，进行量化打分，以期对进出医疗机构的中成药进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(purposeContent);

        // 评价药品
        Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(drugTitle);
        Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
        document.add(drugContent);

        // 评价过程
        Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(processTitle);
        Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《河北省公立医疗机构中成药遴选评价表》进行量化打分，其评估维度包括传承评价、临床评价、安全评价、技术评价以及市场评价。总分加和为100分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(processContent);

        // 评价结果
        Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(resultTitle);
        Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + doubleToString(trInfoDto.getTotalScore()) + "分，其中传承评价最终得分" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分，临床评价最终得分" + doubleToString(clinicalEvaluation.getTotalScore()) + "分，安全评价最终得分" + doubleToString(safetyEvaluation.getTotalScore()) + "分，技术评价最终得分" + doubleToString(technologyEvaluation.getTotalScore()) + "分，市场评价最终得分" + doubleToString(marketEvaluation.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(totalScoreParagraph);

        // 药学特性
        Paragraph pharmaceuticalTitle = new Paragraph("1、传承评价（共22分，得分：" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        pharmaceuticalTitle.setSpacingBefore(10);
        pharmaceuticalTitle.setSpacingAfter(10);
        document.add(pharmaceuticalTitle);
        addSubItem(document, "1.1 组方来源", inheritanceEvaluation.getRecipeSourceContent(), inheritanceEvaluation.getRecipeSourceScore());
        addSubItemTitle(document, "1.2 理论支撑", inheritanceEvaluation.getTheorySupportScore());
        addSubItem(document, "1.2.1 中医药理论指导", inheritanceEvaluation.getTheoryGuidanceContent(), inheritanceEvaluation.getTheoryGuidanceScore());
        addSubItem(document, "1.2.2 君臣佐使配伍", inheritanceEvaluation.getTheoryCombinationContent(), inheritanceEvaluation.getTheoryCombinationScore());
        addSubItem(document, "1.2.3 君臣药的药性、归经与治疗目标是否相符", inheritanceEvaluation.getTheoryPathogenesisContent(), inheritanceEvaluation.getTheoryPathogenesisScore());
        addSubItem(document, "1.2.4 君臣药的炮制品选择与治疗目标是否相符", inheritanceEvaluation.getTheoryPotContent(), inheritanceEvaluation.getTheoryPotScore());


        addSubItemTitle(document, "1.3 病证结合", inheritanceEvaluation.getDiseaseCombinationScore());
        addSubItem(document, "1.3.1 疾病、证候、症状描述", inheritanceEvaluation.getDiseaseCombinationContent1(), inheritanceEvaluation.getDiseaseCombinationScore1());
        addSubItem(document, "1.3.2 疾病使用西医术语描述", inheritanceEvaluation.getDiseaseCombinationContent2(), inheritanceEvaluation.getDiseaseCombinationScore2());

        // 临床评价
        Paragraph clinicalTitle = new Paragraph("2、临床评价（共25分，得分：" + doubleToString(clinicalEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        clinicalTitle.setSpacingBefore(10);
        clinicalTitle.setSpacingAfter(10);
        document.add(clinicalTitle);
        addSubItem(document, "2.1 临床定位", clinicalEvaluation.getClinicalPositioningContent(), clinicalEvaluation.getClinicalPositioningScore());
        addSubItem(document, "2.2 临床研究", clinicalEvaluation.getClinicalResearchContent(), clinicalEvaluation.getClinicalResearchScore());
        addSubItem(document, "2.3 证据推荐", getEvidenceRecommendationContent(clinicalEvaluation), clinicalEvaluation.getEvidenceRecommendationScore());
        addSubItem(document, "2.4 临床需求", clinicalEvaluation.getClinicalDemandOption(), clinicalEvaluation.getClinicalDemandScore());

        // 安全评价
        Paragraph safetyTitle = new Paragraph("3、安全评价（共20分，得分：" + doubleToString(safetyEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        safetyTitle.setSpacingBefore(10);
        safetyTitle.setSpacingAfter(10);
        document.add(safetyTitle);
        // 安全信息评价
        Paragraph safetyInfoTitle = createHeadWord(12, "3.1 安全信息评价（" + doubleToString(safetyEvaluation.getSafetyInfoScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.1安全信息评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        safetyInfoTitle.setSpacingBefore(10);
        safetyInfoTitle.setSpacingAfter(10);
        document.add(safetyInfoTitle);
        addSubSubItem(document, "3.1.1 不良反应、禁忌等描述", safetyEvaluation.getAdverseReactionContent(), safetyEvaluation.getAdverseReactionScore());
        addSubSubItem(document, "3.1.2 说明书中警示语或注意事项", safetyEvaluation.getWarningNoteContent(), safetyEvaluation.getWarningNoteScore());
        addSubSubItem(document, "3.1.3 辅料", String.valueOf(safetyEvaluation.getExcipient()), safetyEvaluation.getExcipientScore());
        addSubSubItem(document, "3.1.4 安全性再评价", safetyEvaluation.getSafetyReevaluationContent(), safetyEvaluation.getSafetyReevaluationScore());
        // 人群限制
        Paragraph populationRestrictionTitle = createHeadWord(12, "3.2 人群限制（" + doubleToString(safetyEvaluation.getCrowdRestrictionScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.2人群限制（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        populationRestrictionTitle.setSpacingBefore(10);
        populationRestrictionTitle.setSpacingAfter(10);
        document.add(populationRestrictionTitle);
        addSubSubItem(document, "3.2.1 儿童用药", safetyEvaluation.getPediatricDrugUseContent(), safetyEvaluation.getPediatricDrugUseScore());
        addSubSubItem(document, "3.2.2 妊娠期妇女用药", safetyEvaluation.getPregnancyDrugUseContent(), safetyEvaluation.getPregnancyDrugUseScore());
        addSubSubItem(document, "3.2.3 哺乳期妇女用药", safetyEvaluation.getLactationDrugUseContent(), safetyEvaluation.getLactationDrugUseScore());
        addSubSubItem(document, "3.2.4 肝功能异常者用药", safetyEvaluation.getLiverDysfunctionDrugUseContent(), safetyEvaluation.getLiverDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.5 肾功能异常者用药", safetyEvaluation.getKidneyDysfunctionDrugUseContent(), safetyEvaluation.getKidneyDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.6 运动员用药", safetyEvaluation.getAthleteDrugUseContent(), safetyEvaluation.getAthleteDrugUseScore());
        // 不良反应分级
        addSubItem(document, "3.3 不良反应分级", safetyEvaluation.getAdverseReactionStratificationContent(), safetyEvaluation.getAdverseReactionStratificationScore());

        // 技术评价
        Paragraph technologyTitle = createHeadWord(14, "4、技术评价（共14分，得分：" + doubleToString(technologyEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT); // new Paragraph("4、技术评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        technologyTitle.setSpacingBefore(10);
        technologyTitle.setSpacingAfter(10);
        document.add(technologyTitle);
        // 适宜性
        Paragraph suitabilityTitle = createHeadWord(12, "4.1 适宜性（" + doubleToString(technologyEvaluation.getSuitabilityScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("4.1适宜性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        suitabilityTitle.setSpacingBefore(10);
        suitabilityTitle.setSpacingAfter(10);
        document.add(suitabilityTitle);
        addSubSubItem(document, "4.1.1 给药频次", technologyEvaluation.getAdministrationFrequencyContent(), technologyEvaluation.getAdministrationFrequencyScore());
        addSubSubItem(document, "4.1.2 包装规格", technologyEvaluation.getPackagingSpecificationOption(), technologyEvaluation.getPackagingSpecificationScore());
        addSubSubItem(document, "4.1.3 采用大包装", technologyEvaluation.getLargePackageAdoptionOption(), technologyEvaluation.getLargePackageAdoptionScore());
        addSubSubItem(document, "4.1.4 单次用量", technologyEvaluation.getSingleDoseOption(), technologyEvaluation.getSingleDoseScore());
        addSubSubItem(document, "4.1.5 疗程", technologyEvaluation.getCourseOfTreatmentContent(), technologyEvaluation.getCourseOfTreatmentScore());
        addSubSubItem(document, "4.1.6 贮藏", technologyEvaluation.getStorageContent(), technologyEvaluation.getStorageScore());
        addSubSubItem(document, "4.1.7 有效期", String.valueOf(technologyEvaluation.getValidityPeriodContent()), technologyEvaluation.getValidityPeriodScore());
        addSubItem(document, "4.2 国家中药保护品种", String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), technologyEvaluation.getNationalTraditionalChineseMedicineProtectionScore());
        // 附加属性
        Paragraph additionalAttributesTitle = createHeadWord(12, "4.3 附加属性（" + doubleToString(technologyEvaluation.getAdditionalZodiacScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("4.3附加属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        additionalAttributesTitle.setSpacingBefore(10);
        additionalAttributesTitle.setSpacingAfter(10);
        document.add(additionalAttributesTitle);
        addSubSubItem(document, "4.3.1 中国药典", String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), technologyEvaluation.getChinesePharmacopoeiaScore());
        addSubSubItem(document, "4.3.2 专利", technologyEvaluation.getPatentNumber(), technologyEvaluation.getPatentScore());
        addSubSubItem(document, "4.3.3 独家品种", technologyEvaluation.getExclusiveVarietyInfo(), technologyEvaluation.getExclusiveVarietyScore());

        // 市场评价
        Paragraph marketTitle = createHeadWord(14, "5、市场评价（共19分，得分：" + doubleToString(marketEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT);// new Paragraph("5、市场评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        marketTitle.setSpacingBefore(10);
        marketTitle.setSpacingAfter(10);
        document.add(marketTitle);
        addSubItem(document, "5.1 市场独特性", marketEvaluation.getMarketUniquenessOption(), marketEvaluation.getMarketUniquenessScore());
        // 单独加一横
        if (StringUtils.isNotEmpty(marketEvaluation.getMarketUniquenessContent())) {
            Paragraph marketUniquenessInfo = createDataWord("原因：" + marketEvaluation.getMarketUniquenessContent());
            document.add(marketUniquenessInfo);
        }
        addSubItemTitle(document, "5.2 经济性", marketEvaluation.getEconomicScore());
        addSubItem(document, "5.2.1 日均治疗费用", marketEvaluation.getDailyTreatmentCostOption(), marketEvaluation.getDailyTreatmentCostScore());
        addSubItem(document, "5.2.2 经济学优势", getEvidenceRecommendationContentByJson(jsonObjects.getJSONObject("trMarketEvaluationDto").getJSONArray("economicAdvantageOption")), marketEvaluation.getEconomicAdvantageScore());

        // 政策属性
        Paragraph policyAttributeTitle = createHeadWord(12, "5.3 政策属性（" + doubleToString(marketEvaluation.getPolicyAttributeScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("5.3政策属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        policyAttributeTitle.setSpacingBefore(10);
        policyAttributeTitle.setSpacingAfter(10);
        document.add(policyAttributeTitle);
        addSubSubItem(document, "5.3.1 国家基本药物", marketEvaluation.getNationalEssentialDrugsRequirement(), marketEvaluation.getNationalEssentialDrugsScore());
        addSubSubItem(document, "5.3.2 国家医保药品", marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), marketEvaluation.getNationalMedicalInsuranceDrugsScore());
        addSubSubItem(document, "5.3.3 集中带量采购药品或国家谈判品种（协议期内）", marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), marketEvaluation.getCentralizedVolumePurchasingDrugsScore());
        addSubItemTitle(document, "5.4 生产企业状况", marketEvaluation.getProductionEnterpriseStatusScore());
        addSubItem(document, "5.4.1 生产企业", marketEvaluation.getProductionEnterpriseContent(), marketEvaluation.getProductionEnterpriseScore());
        addSubItem(document, "5.4.2 独立的GAP种植基地或全流程质量可追溯体系", marketEvaluation.getOwnPlantingBaseOption(), marketEvaluation.getOwnPlantingBaseScore());

        document.close();
    }

    @Override
    public void guideDownloadWord(String id, HttpServletResponse response) throws IOException, DocumentException {
        JSONObject drugAnalyzeData = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData == null) guideDownloadWordPc(id, response);
        if (drugAnalyzeData != null) {
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            Font font = createFontWord(13, Font.NORMAL);
            String fileName = drugAnalyzeData.getString("title");
            String drugName = drugAnalyzeData.getString("drugName");
            String drugInfo = drugAnalyzeData.getString("drugInfo");
            String diseaseName = drugAnalyzeData.getString("disease");
            // 总得分
            String totalScore = drugAnalyzeData.getJSONObject("overallSummary").getString("comprehensiveScore");
            // 推荐情况
            String status = drugAnalyzeData.getJSONObject("overallSummary").getString("status");
            String recommendation = drugAnalyzeData.getJSONObject("overallSummary").getString("recommendation");
            // 药学特性
            String pharmaceuticalCharacteristicsScore = "0";
            // 有效性
            String effectivenessScore = "0";
            // 安全性
            String safetyScore = "0";
            // 经济性
            String economicalScore = "0";
            // 其他属性
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
            // 是否属于国家基本药物
            boolean essentialMedicines = false;
            // 否被纳入了国家医保目录
            boolean reimbursementList = false;
            String reimbursement = "";
            String paymentLimits = "";
            // 是否列为国家集中采购药品
            boolean procurementOfDrugs = false;
            // 国家基本药物得分
            String essentialMedicinesScore = "0";
            // 国家医保目录得分
            String reimbursementListScore = "0";
            // 国家集中采购药品得分
            String procurementOfDrugsScore = "0";
            JSONObject otherAttributes = drugAnalyzeData.getJSONObject("otherAttributes");
            if (otherAttributes != null) {
                // 判定药品归属
                essentialMedicines = otherAttributes.getBoolean("essentialMedicines");
                paymentLimits = otherAttributes.getString("paymentLimits");
                reimbursementList = otherAttributes.getBoolean("reimbursementList");
                if (reimbursementList) {
                    reimbursement = otherAttributes.getString("reimbursement");
                }
                procurementOfDrugs = otherAttributes.getBoolean("procurementOfDrugs");
                // 判定得分
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
            // 创建一个文档（默认大小A4，边距36, 36, 36, 36）
            Document document = new Document();
            // 设置文档大小

            document.setPageSize(com.lowagie.text.PageSize.A4);
            document.setMargins(50, 50, 50, 50);

            // 创建writer，通过writer将文档写入磁盘
            RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
            // 打开文档，只有打开后才能往里面加东西
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

            // 设置报告名称
            Paragraph paragraphTitle = createDataWordV1(fileName);
            paragraphTitle.setAlignment(Element.ALIGN_CENTER);
            paragraphTitle.setSpacingBefore(190);
            paragraphTitle.setSpacingAfter(190);
            document.add(paragraphTitle);

            Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", Element.ALIGN_CENTER);
            headWord1.setAlignment(Element.ALIGN_CENTER);
            headWord1.setSpacingBefore(120);
            headWord1.setSpacingAfter(8);
            document.add(headWord1);
            Calendar calendar = Calendar.getInstance();
            // 创建日期格式化对象
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            // 格式化日期
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_CENTER);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);


            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);


            // 摘要 = 目的 + 方法 + 结果与结论
            document.newPage();
            Paragraph paragraph = new Paragraph();
            Chunk chunkAbstract = new Chunk("摘要：", createFontWord(12, Font.BOLD));
            paragraph.add(chunkAbstract);
            // 目的
            Chunk chunkObjective = new Chunk("目的 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkObjective);
            paragraph.add(new Chunk("依据《中国医疗机构药品评价与遴选快速指南（第二版）》（简称《指南》） 对" + drugName + "治疗" + diseaseName + "进行药品临床综合评价。", createFontWord(13, Font.NORMAL)));
            // 方法
            Chunk chunkMethod = new Chunk("方法 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkMethod);
            paragraph.add(new Chunk("该指南通过对药品药学特性（28分），有效性（27分），安全性（25分），经济性（10分）和其他属性（10分） 5 个方面内容，对" + drugName + "治疗" + diseaseName + "临床综合评价进行归纳总结。", createFontWord(13, Font.NORMAL)));
            // 结果与结论
            Chunk chunkConclusion = new Chunk("结果与结论 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkConclusion);
            recommendation = recommendation.replace("临床上", "");
//            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，"+status+"临床上使用" + drugName + "用于治疗" + diseaseName + "。", createFontWord(13, Font.NORMAL)));
            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，" + recommendation, createFontWord(13, Font.NORMAL)));
            paragraph.setSpacingBefore(10);
            paragraph.setSpacingAfter(10);
            document.add(paragraph);
            // 一、评价目的
            document.add(createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT));
            Paragraph evaluationPurposeData = createDataWord("本研究通过药学特性、安全性、有效性、经济性以及其他属性5个维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。");
            evaluationPurposeData.setFirstLineIndent(25);
            document.add(evaluationPurposeData);
            // 二、评价药品
            document.add(createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT));
            Paragraph evaluationDrugData = createDataWord(drugInfo);
            evaluationDrugData.setFirstLineIndent(25);
            document.add(evaluationDrugData);
            // 三、评价过程
            document.add(createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT));
            Paragraph evaluationProcessData = createDataWord("本研究的研究方法主要是对" + drugName + "治疗" + diseaseName + "进行药品临床综合价值评估，根据《中国医疗机构药品评价与遴选快速指南（第二版）》进行量化打分，其评估维度包括药学特性、安全性、有效性、经济性以及其他属性。总分加和为100分。");
            evaluationProcessData.setFirstLineIndent(25);
            document.add(evaluationProcessData);
            // 四、评价结果
            document.add(createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT));
            Paragraph evaluationInfoData = createDataWord(drugName + "治疗" + diseaseName + "综合评价结果最终得分共计" + totalScore + "分，其中药学特性最终得分" + pharmaceuticalCharacteristicsScore + "分，有效性最终得分" + effectivenessScore + "分，安全性最终得分" + safetyScore + "分，经济性最终得分" + economicalScore + "分，其他属性最终得分" + otherAttributesScore + "分。具体评分结果如下：");
            evaluationInfoData.setFirstLineIndent(25);
            document.add(evaluationInfoData);
            // 1、药学特性（共28分，得分：24分）
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
            // 1.1 药理作用
            document.add(createHeadSecondWord("1.1 药理作用（" + pharmaceuticalScoreMap.get("药理作用") + "）"));
            Paragraph data11 = createDataWord(pharmaceuticalDataMap.get("药理作用"));
            data11.setFirstLineIndent(25);
            document.add(data11);
            // 1.2 体内过程
            document.add(createHeadSecondWord("1.2 体内过程（" + pharmaceuticalScoreMap.get("体内过程") + "）"));
            Paragraph data12 = createDataWord(pharmaceuticalDataMap.get("体内过程"));
            data12.setFirstLineIndent(25);
            document.add(data12);
            // 1.3 药剂学与使用方法
            document.add(createHeadSecondWord("1.3 药剂学与使用方法（" + pharmaceuticalScoreMap.get("药剂学与使用方法") + "）"));
            String txt12 = pharmaceuticalDataMap.get("药剂学与使用方法");
            if (StringUtils.isNotBlank(txt12)) {
                Paragraph data13 = createDataWord(txt12.replaceAll("</br>", "\n"));
                data13.setFirstLineIndent(25);
                document.add(data13);
            }
            // 1.3 药品特性相关内容
            // 1.3.1 成分
            document.add(createHeadSecondWord("1.3.1 成分（" + pharmaceuticalScoreMap.get("成分") + "）"));
            Paragraph data131 = createDataWord(pharmaceuticalDataMap.get("成分"));
            data131.setFirstLineIndent(25); // 首行缩进
            document.add(data131);

            // 1.3.2 规格与包装
            document.add(createHeadSecondWord("1.3.2 规格与包装（" + pharmaceuticalScoreMap.get("规格与包装") + "）"));
            Paragraph data132 = createDataWord(pharmaceuticalDataMap.get("规格与包装"));
            data132.setFirstLineIndent(25);
            document.add(data132);

            // 1.3.3 剂型
            document.add(createHeadSecondWord("1.3.3 剂型（" + pharmaceuticalScoreMap.get("剂型") + "）"));
            Paragraph data133 = createDataWord(pharmaceuticalDataMap.get("剂型"));
            data133.setFirstLineIndent(25);
            document.add(data133);

            // 1.3.4 给药剂量
            document.add(createHeadSecondWord("1.3.4 给药剂量（" + pharmaceuticalScoreMap.get("给药剂量") + "）"));
            Paragraph data134 = createDataWord(pharmaceuticalDataMap.get("给药剂量"));
            data134.setFirstLineIndent(25);
            document.add(data134);

            // 1.3.5 给药频次
            document.add(createHeadSecondWord("1.3.5 给药频次（" + pharmaceuticalScoreMap.get("给药频次") + "）"));
            Paragraph data135 = createDataWord(pharmaceuticalDataMap.get("给药频次"));
            data135.setFirstLineIndent(25);
            document.add(data135);

            // 1.3.6 使用方便性
            document.add(createHeadSecondWord("1.3.6 使用方便性（" + pharmaceuticalScoreMap.get("使用方便性") + "）"));
            Paragraph data136 = createDataWord(pharmaceuticalDataMap.get("使用方便性"));
            data136.setFirstLineIndent(25);
            document.add(data136);
            // 1.4 贮藏条件
            document.add(createHeadSecondWord("1.4 贮藏条件（" + pharmaceuticalScoreMap.get("贮藏条件") + "）"));
            Paragraph data14 = createDataWord(pharmaceuticalDataMap.get("贮藏条件"));
            data14.setFirstLineIndent(25);
            document.add(data14);
            // 1.5 药品有效期
            document.add(createHeadSecondWord("1.5 药品有效期（" + pharmaceuticalScoreMap.get("有效期") + "）"));
            Paragraph data15 = createDataWord(pharmaceuticalDataMap.get("有效期"));
            data15.setFirstLineIndent(25);
            document.add(data15);
            // 2、有效性（共27分，得分：21分）
            document.add(createHeadWord(14, "2、有效性（共27分，得分：" + effectivenessScore + "分）", Element.ALIGN_LEFT));
            JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
            if (effectiveness != null) {
                // 适应症得分
                String indicationScore = effectiveness.getString("indicationScore") != null ? effectiveness.getString("indicationScore") : "0";
                // 证据推荐详情得分推荐得分
                String guideAndLiteratureScore = effectiveness.getString("guideAndLiteratureScore") != null ? effectiveness.getString("guideAndLiteratureScore") : "0";
                // 临床疗效得分
                String effectiveScore = effectiveness.getString("effectivenessScore") != null ? effectiveness.getString("effectivenessScore") : "0";
                // 2.1 适应症
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
                    // 2.2 指南推荐
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
                            if (i == 0) {
                                continue;
                            } else {
                                JSONArray jsonArray = effectivenessArr.getJSONArray(i);
                                String guideContent = jsonArray.getString(1) + "发表的《" +
                                        jsonArray.getString(0) + "》，" + jsonArray.getString(4);
                                Paragraph fontWord = createDataWord("（" + x1 + "）" + guideContent);
                                x1++;
                                fontWord.setFirstLineIndent(25);
                                document.add(fontWord);

                            }

                        }
                    } else {
                        if (CollUtil.isEmpty(effectiveness.getJSONArray("literature"))) {
                            Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南或系统评价/Meta分析等证据推荐。");
                            effectivenessDataParagraph.setFirstLineIndent(25);
                            document.add(effectivenessDataParagraph);

                        } else {
                            // 2.2 文献推荐
                            String literature = effectiveness.getJSONArray("literature").toJSONString();
//                        Table literatureTable = new Table(4);
                            JSONArray literatureArr = JSONArray.parseArray(literature);
                            if (literatureArr.size() > 1) {
//                        document.add(createHeadSecondWord("2.2.1 文献推荐"));
                                for (int i = 0; i < literatureArr.size(); i++) {
                                    JSONArray jsonArray = literatureArr.getJSONArray(i);

                                    String literatureContent = jsonArray.getString(1) + "发表的《" +
                                            jsonArray.getString(0) + "》，" + jsonArray.getString(4);
                                    Paragraph fontWord = createDataWord("（" + x1 + "）" + literatureContent);
                                    x1++;
                                    fontWord.setFirstLineIndent(25);
                                    document.add(fontWord);


                                }
                            } else {
                                Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南或系统评价/Meta分析等证据推荐。");
                                effectivenessDataParagraph.setFirstLineIndent(25);
                                document.add(effectivenessDataParagraph);
                            }
                        }
                    }
                }
                // 2.3 临床疗效
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
            // 3、安全性（共25分，得分：17.5分）
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
            // 3.1 中度不良反应
            document.add(createHeadSecondWord("3.1 中度不良反应（" + safetyScoreMap.get("中度不良反应") + "）"));
            Paragraph data31 = createDataWord(safetyDataMap.get("中度不良反应"));
            data31.setFirstLineIndent(25);
            document.add(data31);
            // 3.2 重度不良反应
            document.add(createHeadSecondWord("3.2 重度不良反应（" + safetyScoreMap.get("重度不良反应") + "）"));
            Paragraph data32 = createDataWord(safetyDataMap.get("重度不良反应"));
            data32.setFirstLineIndent(25);
            document.add(data32);
            // 3.3 特殊人群
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
            // 3.4 相互作用
            document.add(createHeadSecondWord("3.4 相互作用（" + safetyScoreMap.get("相互作用") + "）"));
            Paragraph data34 = createDataWord(safetyDataMap.get("相互作用"));
            data34.setFirstLineIndent(25);
            document.add(data34);
            // 3.5 其他
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

            // 4、经济性（共10分，得分：1.21分）
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
            // 5、其他属性（共10分，得分：5.8分）
            document.add(createHeadWord(14, "5、其他属性（共" + guideMaxMap.get("其他属性") + "分，得分：" + otherAttributesScore + "分）", Element.ALIGN_LEFT));
            // 5.1 国家医保
            document.add(createHeadSecondWord("5.1 国家医保（" + reimbursementListScore + "）"));
            Paragraph data51 = createDataWord(drugName + (reimbursementList ? "在国家医保目录中，属于医保" + reimbursement : "不在国家医保目录中。") + (reimbursementList ? (StringUtils.isNotBlank(paymentLimits) ? "，" + paymentLimits + ((StrUtil.endWith(paymentLimits, "。")) ? "" : "。") : "，无支付限制。") : ""));
            data51.setFirstLineIndent(25);
            document.add(data51);
            // 5.2 国家基本药物
            char triangleSymbol = (char) 30;
            document.add(createHeadSecondWord("5.2 国家基本药物（" + essentialMedicinesScore + "）"));
            Paragraph data52 = createDataWord(drugName + (essentialMedicines ? "已被纳入国家基本药物目录" : "并未被纳入国家基本药物目录。") + (essentialMedicines ? (("").equals(otherAttributes.getString("essentialType")) ? "，无△" : "，有") + otherAttributes.getString("essentialType") + "要求。" : ""));
            data52.setFirstLineIndent(25);
            document.add(data52);
            // 5.3 国家集中采购药品
            document.add(createHeadSecondWord("5.3 国家集中采购药品（" + procurementOfDrugsScore + "）"));
            Paragraph data53 = createDataWord(drugName + (procurementOfDrugs ? "已被" : "并未被") + "列为国家集中采购药品。");
            data53.setFirstLineIndent(25);
            document.add(data53);
            // 5.4 原研/参比/一致性评价
            assert otherAttributes != null;
            document.add(createHeadSecondWord("5.4 原研/参比/一致性评价（" + otherAttributes.getString("guideDrugSituationScore") + "）"));
            Paragraph data54 = createDataWord(otherAttributes.getString("guideDrugSituation"));
            data54.setFirstLineIndent(25);
            document.add(data54);
            // 5.5 生成企业状况
            document.add(createHeadSecondWord("5.5 生产企业状况（" + otherAttributes.getString("guideEnterpriseScore") + "）"));
            Paragraph data55 = createDataWord(otherAttributes.getString("guideEnterprise"));
            data55.setFirstLineIndent(25);
            document.add(data55);
            // 5.6 全球使用情况
            document.add(createHeadSecondWord("5.6 全球使用情况（" + otherAttributes.getString("guideCountryScore") + "）"));
            Paragraph data56 = createDataWord(otherAttributes.getString("guideCountry"));
            data56.setFirstLineIndent(25);
            document.add(data56);

            // 关闭文档，才能输出
            document.close();
            writer.close();
            log.info("----------指南报告下载完成----------");
        } 
    }

    @Override
    public void guideDownloadWordPc(String id, HttpServletResponse response) throws IOException, DocumentException {
        JSONObject data = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "drug_score_tra");
        if (data != null) {
            ReportDownMode reportDownMode = JSON.parseObject(data.toJSONString(), ReportDownMode.class);
            reportDownMode.setPackageName(data.getString("package"));
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            Font font = createFontWord(13, Font.NORMAL);
            DrugInfoNew drugInfoNew = mongoTemplate.findById(reportDownMode.getDrugId(), DrugInfoNew.class);
            String fileName = reportDownMode.getSimpleTitle();
            String drugName = reportDownMode.getDrugName();
            String drugInfo = reportDownMode.getDrugInfo();
            String diseaseName = reportDownMode.getDisease();
            // 总得分
            String totalScore = reportDownMode.getTotalScore();
            // 推荐情况
            String status = reportDownMode.getStatus();
            String recommendation = reportDownMode.getRecommendation();
            // 药学特性
            String pharmaceuticalCharacteristicsScore = reportDownMode.getCharacteristicScore();
            // 有效性
            String effectivenessScore = reportDownMode.getEffectiveScore();
            // 安全性
            String safetyScore = reportDownMode.getSafetyScore();
            // 经济性
            String economicalScore = reportDownMode.getEconomicScore();
            // 其他属性
            String otherAttributesScore = reportDownMode.getOtherScore();


            log.info("----------开始进行指南报告下载----------");
            response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
            ServletOutputStream outputStream = response.getOutputStream();
            // 创建一个文档（默认大小A4，边距36, 36, 36, 36）
            Document document = new Document();
            // 设置文档大小

            document.setPageSize(PageSize.A4);
            document.setMargins(50, 50, 50, 50);

            // 创建writer，通过writer将文档写入磁盘
            RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
            // 打开文档，只有打开后才能往里面加东西
            document.open();
            ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
            InputStream inputStreamImg = classPathResource.getInputStream();
            byte[] bytes = IOUtils.toByteArray(inputStreamImg);
            Image logo = Image.getInstance(bytes);
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

            // 设置报告名称
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
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);

            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);


            // 摘要 = 目的 + 方法 + 结果与结论
            document.newPage();
            Paragraph paragraph = new Paragraph();
            Chunk chunkAbstract = new Chunk("摘要：", createFontWord(12, Font.BOLD));
            paragraph.add(chunkAbstract);
            // 目的
            Chunk chunkObjective = new Chunk("目的 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkObjective);
            paragraph.add(new Chunk("依据《中国医疗机构药品评价与遴选快速指南（第二版）》（简称《指南》） 对" + drugName + "治疗" + diseaseName + "进行药品临床综合评价。", createFontWord(12, Font.NORMAL)));
            // 方法
            Chunk chunkMethod = new Chunk("方法 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkMethod);
            paragraph.add(new Chunk("该指南通过对药品药学特性（28分），有效性（27分），安全性（25分），经济性（10分）和其他属性（10分） 5 个方面内容，对" + drugName + "治疗" + diseaseName + "临床综合评价进行归纳总结。", createFontWord(12, Font.NORMAL)));
            // 结果与结论
            Chunk chunkConclusion = new Chunk("结果与结论 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkConclusion);
            recommendation = recommendation.replace("临床上", "");
//            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，"+status+"临床上使用" + drugName + "用于治疗" + diseaseName + "。", createFontWord(13, Font.NORMAL)));
            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，" + recommendation, createFontWord(12, Font.NORMAL)));
            paragraph.setSpacingBefore(10);
            paragraph.setSpacingAfter(10);
            document.add(paragraph);
            // 一、评价目的
            document.add(createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT));
            Paragraph evaluationPurposeData = createDataWord("本研究通过药学特性、安全性、有效性、经济性以及其他属性5个维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。");
            evaluationPurposeData.setFirstLineIndent(25);
            document.add(evaluationPurposeData);
            // 二、评价药品
            document.add(createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT));
            Paragraph evaluationDrugData = createDataWord(drugInfo);
            evaluationDrugData.setFirstLineIndent(25);
            document.add(evaluationDrugData);
            // 三、评价过程
            document.add(createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT));
            Paragraph evaluationProcessData = createDataWord("本研究的研究方法主要是对" + drugName + "治疗" + diseaseName + "进行药品临床综合价值评估，根据《中国医疗机构药品评价与遴选快速指南（第二版）》进行量化打分，其评估维度包括药学特性、安全性、有效性、经济性以及其他属性。总分加和为100分。");
            evaluationProcessData.setFirstLineIndent(25);
            document.add(evaluationProcessData);
            // 四、评价结果
            document.add(createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT));
            Paragraph evaluationInfoData = createDataWord(drugName + "治疗" + diseaseName + "综合评价结果最终得分共计" + totalScore + "分，其中药学特性最终得分" + pharmaceuticalCharacteristicsScore + "分，有效性最终得分" + effectivenessScore + "分，安全性最终得分" + safetyScore + "分，经济性最终得分" + economicalScore + "分，其他属性最终得分" + otherAttributesScore + "分。具体评分结果如下：");
            evaluationInfoData.setFirstLineIndent(25);
            document.add(evaluationInfoData);
            // 1、药学特性（共28分，得分：24分）
            document.add(createHeadWord(14, "1、药学特性（共" + 28 + "分，得分：" + pharmaceuticalCharacteristicsScore + "分）", Element.ALIGN_LEFT));

            // 1.1 药理作用
            document.add(createHeadSecondWord("1.1 药理作用（" + reportDownMode.getPharmacologyScore() + "）"));
            Paragraph data11 = createDataWord(reportDownMode.getPharmacology());
            data11.setFirstLineIndent(25);
            document.add(data11);
            // 1.2 体内过程
            document.add(createHeadSecondWord("1.2 体内过程（" + reportDownMode.getPharmacokineticsScore() + "）"));
            Paragraph data12 = createDataWord(reportDownMode.getPharmacokinetics());
            data12.setFirstLineIndent(25);
            document.add(data12);
            // 1.3 药剂学与使用方法
            document.add(createHeadSecondWord("1.3 药剂学与使用方法（" + reportDownMode.getUsageAndDosageScore() + "）"));

            document.add(createHeadSecondWord("1.3.1 主要成分与辅料（" + reportDownMode.getComponentScore() + "）"));
            String txt131 = reportDownMode.getComponent();
            if (StringUtils.isNotBlank(txt131)) {
                Paragraph data131 = createDataWord(txt131.replaceAll("</br>", "\n"));
                data131.setFirstLineIndent(25);
                document.add(data131);
            }

            document.add(createHeadSecondWord("1.3.2 规格与包装（" + reportDownMode.getPackageScore() + "）"));
            String txt132 = reportDownMode.getPackageName();
            if (StringUtils.isNotBlank(txt132)) {
                Paragraph data132 = createDataWord(txt132.replaceAll("</br>", "\n"));
                data132.setFirstLineIndent(25);
                document.add(data132);
            }

            document.add(createHeadSecondWord("1.3.3 剂型（" + reportDownMode.getDosageFormScore() + "）"));
            String txt133 = reportDownMode.getDosageForm();
            if (StringUtils.isNotBlank(txt133)) {
                Paragraph data133 = createDataWord(txt133.replaceAll("</br>", "\n"));
                data133.setFirstLineIndent(25);
                document.add(data133);
            }

            document.add(createHeadSecondWord("1.3.4 给药剂量（" + reportDownMode.getDoseScore() + "）"));
            String txt134 = reportDownMode.getDose();
            if (StringUtils.isNotBlank(txt134)) {
                Paragraph data134 = createDataWord(txt134.replaceAll("</br>", "\n"));
                data134.setFirstLineIndent(25);
                document.add(data134);
            }

            document.add(createHeadSecondWord("1.3.5 给药频次（" + reportDownMode.getDrugFrequencyScore() + "）"));
            String txt135 = reportDownMode.getDrugFrequency();
            if (StringUtils.isNotBlank(txt135)) {
                Paragraph data135 = createDataWord(txt135.replaceAll("</br>", "\n"));
                data135.setFirstLineIndent(25);
                document.add(data135);
            }

            document.add(createHeadSecondWord("1.3.6 使用方便（" + reportDownMode.getConvenienceScore() + "）"));
            String txt136 = reportDownMode.getConvenience();
            if (StringUtils.isNotBlank(txt136)) {
                Paragraph data136 = createDataWord(txt136.replaceAll("</br>", "\n"));
                data136.setFirstLineIndent(25);
                document.add(data136);
            }

            // 1.4 贮藏条件
            document.add(createHeadSecondWord("1.4 贮藏条件（" + reportDownMode.getStorageScore() + "）"));
            Paragraph data14 = createDataWord(reportDownMode.getStorage());
            data14.setFirstLineIndent(25);
            document.add(data14);
            // 1.5 药品有效期
            document.add(createHeadSecondWord("1.5 药品有效期（" + reportDownMode.getIndateScore() + "）"));
            Paragraph data15 = createDataWord(reportDownMode.getIndate());
            data15.setFirstLineIndent(25);
            document.add(data15);
            // 2、有效性（共27分，得分：21分）
            document.add(createHeadWord(14, "2、有效性（共27分，得分：" + effectivenessScore + "分）", Element.ALIGN_LEFT));
//            JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
//            if (effectiveness != null) {
            // 适应症得分
            String indicationScore = reportDownMode.getIndicationScore();
            // 证据推荐详情得分推荐得分
            String guideAndLiteratureScore = reportDownMode.getGuideScore();
            // 临床疗效得分
            String effectiveScore = reportDownMode.getEffectiveScore();
            // 2.1 适应症
            document.add(createHeadSecondWord("2.1 适应症（" + indicationScore + "）"));
            if (StringUtils.isNotBlank(reportDownMode.getIndication())) {
                Paragraph effectivenessDataParagraph1 = createDataWord(reportDownMode.getIndication());
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
            if (CollUtil.isNotEmpty(reportDownMode.getGuide())) {
                List<ReportDownMode.Guide> guidePc = reportDownMode.getGuide();
                for (ReportDownMode.Guide jsonObject : guidePc) {
                    String showField = jsonObject.getTitle();
                    String content = jsonObject.getContent();
                    Paragraph fontWord = createDataWord("（" + x + "）" + showField);
                    Paragraph contentWord = createDataWord(content);
                    fontWord.setFirstLineIndent(25);
                    document.add(fontWord);
                    contentWord.setFirstLineIndent(30);
                    document.add(contentWord);
                    x++;

                }

            } else {
                Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南或系统评价/Meta分析等证据推荐。");
                effectivenessDataParagraph.setFirstLineIndent(25);
                document.add(effectivenessDataParagraph);
            }

            // 2.3 临床疗效
            document.add(createHeadSecondWord("2.3 临床疗效（" + reportDownMode.getEffectivenessScore() + "）"));
            if (StringUtils.isNotBlank(reportDownMode.getEffectiveness())) {
                Paragraph effectivenessDataParagraph3 = createDataWord(reportDownMode.getEffectiveness());
                effectivenessDataParagraph3.setFirstLineIndent(25);
                document.add(effectivenessDataParagraph3);
            } else {
                Paragraph effectivenessDataParagraph3 = createDataWord("暂无数据");
                effectivenessDataParagraph3.setFirstLineIndent(25);
                document.add(effectivenessDataParagraph3);
            }
//            }
            // 3、安全性（共25分，得分：17.5分）
            document.add(createHeadWord(14, "3、安全性（共" + 25 + "分，得分：" + safetyScore + "分）", Element.ALIGN_LEFT));
            String specialPopulationsScore = reportDownMode.getSpecialCrowdScore();
            String safetyOtherScore = reportDownMode.getOtherSafetyScore();


            // 3.1 中度不良反应
            document.add(createHeadSecondWord("3.1 不良反应（" + reportDownMode.getAdverseReactionScore() + "）"));
            document.add(createHeadSecondWord("3.1.1 中度不良反应（" + reportDownMode.getMildAdverseReactionScore() + "）"));
            Paragraph data31 = createDataWord(reportDownMode.getMildAdverseReaction());
            data31.setFirstLineIndent(25);
            document.add(data31);
            
            document.add(createHeadSecondWord("3.1.2 重度不良反应（" + reportDownMode.getSevereAdverseReactionScore() + "）"));
            Paragraph data32 = createDataWord(reportDownMode.getSevereAdverseReaction());
            data31.setFirstLineIndent(25);
            document.add(data32);
            
            // 3.3 特殊人群
            document.add(createHeadSecondWord("3.2 特殊人群（" + specialPopulationsScore + "）"));

            document.add(createHeadSecondWord("3.2.1 儿童（" + reportDownMode.getChildrenMedicineScore() + "）"));
            String text332 = reportDownMode.getChildrenMedicine();
            if (StringUtils.isNotBlank(text332)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text332 = text332.replaceAll("</br>", "\n");
            }
            Paragraph data332 = createDataWord(text332);
            data332.setFirstLineIndent(25);
            document.add(data332);


            document.add(createHeadSecondWord("3.2.2 老人（" + reportDownMode.getGeriatricMedicineScore() + "）"));
            String text333 = reportDownMode.getGeriatricMedicine();
            if (StringUtils.isNotBlank(text333)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text333 = text333.replaceAll("</br>", "\n");
            }
            Paragraph data333 = createDataWord(text333);
            data333.setFirstLineIndent(25);
            document.add(data333);


            document.add(createHeadSecondWord("3.2.3 妊振期妇女用药（" + reportDownMode.getPregnantWomenScore() + "）"));
            String text331 = reportDownMode.getPregnantWomen();
            if (StringUtils.isNotBlank(text331)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text331 = text331.replaceAll("</br>", "\n");
            }
            Paragraph data331 = createDataWord(text331);
            data331.setFirstLineIndent(25);
            document.add(data331);


            document.add(createHeadSecondWord("3.2.4 哺乳期妇女用药（" + reportDownMode.getLactationScore() + "）"));
            String text3312 = reportDownMode.getLactation();
            if (StringUtils.isNotBlank(text3312)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text3312 = text3312.replaceAll("</br>", "\n");
            }
            Paragraph data3312 = createDataWord(text3312);
            data3312.setFirstLineIndent(25);
            document.add(data3312);


            document.add(createHeadSecondWord("3.2.5 肝功能异常者用药（" + reportDownMode.getLiverScore() + "）"));
            String text334 = reportDownMode.getLiver();
            if (StringUtils.isNotBlank(text334)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text334 = text334.replaceAll("</br>", "");
            }
            Paragraph data334 = createDataWord(text334);
            data334.setFirstLineIndent(25);
            document.add(data334);


            document.add(createHeadSecondWord("3.2.6 肾功能异常者用药（" + reportDownMode.getRenalScore() + "）"));
            String text3342 = reportDownMode.getRenal();
            if (StringUtils.isNotBlank(text3342)) {
//                text33 = text33.substring(0, text33.length() - 5);
                text3342 = text3342.replaceAll("</br>", "");
            }
            Paragraph data3342 = createDataWord(text3342);
            data3342.setFirstLineIndent(25);
            document.add(data3342);


            // 3.4 相互作用
            document.add(createHeadSecondWord("3.4 相互作用（" + reportDownMode.getDrugInteractionScore() + "）"));
            Paragraph data34 = createDataWord(reportDownMode.getDrugInteraction());
            data34.setFirstLineIndent(25);
            document.add(data34);
            // 3.5 其他
            document.add(createHeadSecondWord("3.5 其他（" + safetyOtherScore + "）"));
//            if (StringUtils.isNotBlank(safetyDataMap.get("其他不良反应"))) {
//                Paragraph data35 = createDataWord(safetyDataMap.get("其他不良反应"));
//                data35.setFirstLineIndent(25);
//                document.add(data35);
//            }
            document.add(createHeadSecondWord("3.5.1 不良反应可逆性（" + reportDownMode.getReversibleReactionScore() + "）"));
            String text351 = reportDownMode.getReversibleReaction();
            Paragraph dataWord351 = createDataWord(text351);
            dataWord351.setFirstLineIndent(25);
            document.add(dataWord351);
            document.add(createHeadSecondWord("3.5.2 致畸性、致癌性（" + reportDownMode.getGenicityAdverseReactionScore() + "）"));
            String text352 = reportDownMode.getGenicityAdverseReaction();
            Paragraph dataWord352 = createDataWord(text352);
            dataWord352.setFirstLineIndent(25);
            document.add(dataWord352);
            document.add(createHeadSecondWord("3.5.3 用药警示（" + reportDownMode.getAlertAdverseReactionScore() + "）"));
            String text353 = reportDownMode.getAlertAdverseReaction();
            Paragraph dataWord353 = createDataWord(text353);
            dataWord353.setFirstLineIndent(25);
            document.add(dataWord353);

            // 4、经济性（共10分，得分：1.21分）
            document.add(createHeadWord(14, "4、经济性（共" + 10 + "分，得分：" + economicalScore + "分）", Element.ALIGN_LEFT));
            //（1）同通用名药物：
            document.add(createHeadSecondWord("（1）同通用名药物："));
            String sameGericName = reportDownMode.getEconomic1();
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
            String indicationReplace = reportDownMode.getEconomic2();
            if (StringUtils.isNotBlank(indicationReplace)) {
                Paragraph economicalDataParagraph2 = createDataWord(indicationReplace);
                economicalDataParagraph2.setFirstLineIndent(25);
                document.add(economicalDataParagraph2);
            } else {
                Paragraph effectivenessDataParagraph3 = createDataWord("暂无数据");
                effectivenessDataParagraph3.setFirstLineIndent(25);
                document.add(effectivenessDataParagraph3);
            }

            // 5、其他属性（共10分，得分：5.8分）
            document.add(createHeadWord(14, "5、其他属性（共" + 10 + "分，得分：" + otherAttributesScore + "分）", Element.ALIGN_LEFT));
            // 5.1 国家医保
            document.add(createHeadSecondWord("5.1 国家医保（" + reportDownMode.getIsInsuranceScore() + "）"));
            Paragraph data51 = createDataWord(drugName + reportDownMode.getIsInsurance() + "。");
            data51.setFirstLineIndent(25);
            document.add(data51);
            // 5.2 国家基本药物
            char triangleSymbol = (char) 30;
            document.add(createHeadSecondWord("5.2 国家基本药物（" + reportDownMode.getIsBaseScore() + "）"));
            Paragraph data52 = createDataWord(drugName + reportDownMode.getIsBase() + "。");
            data52.setFirstLineIndent(25);
            document.add(data52);
            // 5.3 国家集中采购药品
            document.add(createHeadSecondWord("5.3 国家集中采购药品（" + reportDownMode.getIsConcentrateScore() + "）"));
            Paragraph data53 = createDataWord(drugName + reportDownMode.getIsConcentrate() + "。");
            data53.setFirstLineIndent(25);
            document.add(data53);
            // 5.4 原研/参比/一致性评价
            document.add(createHeadSecondWord("5.4 原研/参比/一致性评价（" + reportDownMode.getGuideDrugSituationScore() + "）"));
            Paragraph data54 = createDataWord(reportDownMode.getGuideDrugSituation());
            data54.setFirstLineIndent(25);
            document.add(data54);
            // 5.5 生成企业状况
            document.add(createHeadSecondWord("5.5 生产企业状况（" + reportDownMode.getGuideEnterpriseScore() + "）"));
            Paragraph data55 = createDataWord(reportDownMode.getGuideEnterprise());
            data55.setFirstLineIndent(25);
            document.add(data55);
            // 5.6 全球使用情况
            document.add(createHeadSecondWord("5.6 全球使用情况（" + reportDownMode.getGuideCountryScore() + "）"));
            Paragraph data56 = createDataWord(reportDownMode.getGuideCountry1() + "\n" + reportDownMode.getGuideCountry2());
            data56.setFirstLineIndent(25);
            document.add(data56);

            // 关闭文档，才能输出
            document.close();
            writer.close();
            log.info("----------指南报告下载完成----------");
        }
    }











    @Override
    public List<String> getAssociationalWord(String word) {
        if (org.apache.commons.lang3.StringUtils.isBlank(word)) {
            return new ArrayList<>();
        }
        if (word.length() > 20) {
            return new ArrayList<>();
        }
        word = word.toLowerCase();
        PrefixQueryBuilder prefixQueryBuilder = QueryBuilders.prefixQuery("word", word);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(prefixQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(0, 5));
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.ASC, "size"));
        // 尝试去重操作-需定义keyword类型的字段进行去重操作
        // CardinalityAggregationBuilder wordBuilder = AggregationBuilders.cardinality("search").field("word").precisionThreshold(100);
        CollapseBuilder collapseBuilder = new CollapseBuilder("word");
        InnerHitBuilder innerHitBuilder = new InnerHitBuilder();
        innerHitBuilder.setSize(5);
        innerHitBuilder.setName("top_search");
        collapseBuilder.setInnerHits(innerHitBuilder);
        nativeSearchQuery.setCollapseBuilder(collapseBuilder);
        // nativeSearchQuery.setAggregations(new ArrayList<>(Collections.singletonList(wordBuilder)));
        SearchHits<AssociationalWord> search = null;
        try {
            search = RetryUtils.retry(
                    () -> elasticsearchRestTemplate.search(nativeSearchQuery, AssociationalWord.class),
                    3,
                    1000,  // 每次重试间隔1秒
                    e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
            );
            // 使用guideHits做后续处理
        } catch (Exception e) {
            log.error("Search operation failed after retries", e);
            // 这里可以做失败后降级或补偿逻辑
        }
        // 对数据进行处理返回给前台
        List<String> list = new ArrayList<>();
        if (search != null) {
            for (SearchHit<AssociationalWord> associationalWordSearchHit : search) {
                AssociationalWord content = associationalWordSearchHit.getContent();
                list.add(content.getWord());
            }
            return list;
        }
        return list;
    }

    @Override
    public JSONArray getCategory(String type) {
        String cacheKey = "categoryx:" + type;

        // 尝试从缓存中获取数据
        JSONArray cachedData = (JSONArray) redisTemplate.opsForValue().get(cacheKey);
        if (cachedData != null) {
            return cachedData;
        }

        JSONArray jsonArray1 = new JSONArray();
        if (!"1".equals(type)) {
            type = "化药及生物制品";
        } else {
            type = "中成药";
        }
        Query query = new Query(Criteria.where("type").is(type).and("parentId").is("0"));
        query.with(Sort.by(Sort.Order.asc("sort")));
        List<JSONObject> jsonObjects = mongoTemplate.find(query, JSONObject.class, "drug_category_simple1");
        JSONObject others = null;
        for (JSONObject jsonObject : jsonObjects) {
            if ("其他".equals(jsonObject.getString("name"))) {
                continue;
            }
            JSONObject jsonObject1 = new JSONObject();
            jsonObject1.put("name", jsonObject.getString("name"));
            JSONArray jsonObjectLevel2s = new JSONArray();
            jsonObject1.put("children", jsonObjectLevel2s);

            String string = jsonObject.getString("_id");
            List<JSONObject> jsonObjects1 = mongoTemplate.find(new Query(Criteria.where("type").is(type).and("parentId").is(string)), JSONObject.class, "drug_category_simple1");
            for (JSONObject jsonObject2 : jsonObjects1) {
                JSONObject jsonObjectLevel2 = new JSONObject();
                jsonObjectLevel2.put("name", jsonObject2.getString("name"));
                JSONArray jsonObjectLevel3s = new JSONArray();
                jsonObjectLevel2.put("children", jsonObjectLevel3s);
                jsonObjectLevel2s.add(jsonObjectLevel2);
                String string2 = jsonObject2.getString("_id");
                List<JSONObject> jsonObjects2 = mongoTemplate.find(new Query(Criteria.where("type").is(type).and("parentId").is(string2)), JSONObject.class, "drug_category_simple1");
                for (JSONObject jsonObject3 : jsonObjects2) {
                    JSONObject jsonObjectLevel3 = new JSONObject();
                    jsonObjectLevel3.put("name", jsonObject3.getString("name"));
                    JSONArray jsonObjectLevel4s = new JSONArray();
                    jsonObjectLevel3.put("children", jsonObjectLevel4s);
                    jsonObjectLevel3s.add(jsonObjectLevel3);
                    String string3 = jsonObject3.getString("_id");
                    List<JSONObject> jsonObjects3 = mongoTemplate.find(new Query(Criteria.where("type").is(type).and("parentId").is(string3)), JSONObject.class, "drug_category_simple1");
                    for (JSONObject jsonObject4 : jsonObjects3) {
                        JSONObject jsonObjectLevel4 = new JSONObject();
                        jsonObjectLevel4.put("name", jsonObject4.getString("name"));
                        JSONArray jsonObjectLevel5s = new JSONArray();
                        jsonObjectLevel4.put("children", jsonObjectLevel5s);
                        jsonObjectLevel4s.add(jsonObjectLevel4);

                        String string4 = jsonObject4.getString("_id");
                        List<JSONObject> jsonObjects4 = mongoTemplate.find(new Query(Criteria.where("type").is(type).and("parentId").is(string4)), JSONObject.class, "drug_category_simple1");
                        for (JSONObject jsonObject5 : jsonObjects4) {
                            JSONObject jsonObjectLevel5 = new JSONObject();
                            jsonObjectLevel5.put("name", jsonObject5.getString("name"));
                            jsonObjectLevel5s.add(jsonObjectLevel5);
                        }
                    }
                }
            }
            if ("其他".equals(jsonObject.getString("name"))) {
                others = jsonObject1;
            } else {
                jsonArray1.add(jsonObject1);
            }
        }
//            if (others != null){
//                jsonArray1.add(others);
//            }

        // 将查询结果存入缓存
        redisTemplate.opsForValue().set(cacheKey, jsonArray1);


        return jsonArray1;
    }

    @Override
    public ConditionVo getSynonym(String word, Long userId) {
        ConditionVo result = new ConditionVo();
        // pc
        List<WordConditionVo> data = new ArrayList<>();
        result.setData(data);
        // app
        List<Map<String, Object>> appData = new ArrayList<>();
        result.setAppData(appData);
        // 存储原词 及 翻译词
        List<String> wordList = new ArrayList<>();
        word = word.toLowerCase();
        // 保存历史记录
        boolean isSearched = mongoTemplate.exists(new Query(Criteria.where("word").is(word).and("userId").is(userId)), SearchHistory.class);
        if (isSearched) {
            Update update = new Update();
            update.set("timeStamp", System.currentTimeMillis());
            mongoTemplate.updateFirst(new Query(Criteria.where("word").is(word).and("userId").is(userId)), update, SearchHistory.class);
        } else {
            mongoTemplate.save(new SearchHistory(UUID.randomUUID().toString(), word, System.currentTimeMillis(), userId, 0L));
        }

        boolean classifyExists = false; // 是否是分类
        boolean isMedicine = false;  // 是否是药
        boolean exists = false;
//        Pattern pattern = Pattern.compile("^" + Pattern.quote(word) + "$", Pattern.CASE_INSENSITIVE);
//        boolean exists = mongoTemplate.exists(new Query(Criteria.where("abbreviation_english_name_of_the_disease").regex(pattern)), "disease_abbreviation");
        if (!exists) {
            classifyExists = mongoTemplate.exists(new Query(Criteria.where("word").is(word).andOperator(Criteria.where("codeLevel").in(1, 2, 3, 0))), GradeAndDrugs.class);


            // 利用es 查询 中英文对应的翻译词
            BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

            BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
            orBoolQueryBuilder.should().add(QueryBuilders.matchQuery("zhDrugName", word));  // 药品名称
            MultiMatchQueryBuilder drugName1 = QueryBuilders.multiMatchQuery(word, "drugName");
            drugName1.operator(Operator.AND);
            drugName1.slop(0);
            drugName1.type(MultiMatchQueryBuilder.Type.PHRASE);
            orBoolQueryBuilder.should().add(drugName1); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", word));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", word));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", word));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", word));  // 药品英文
            synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);

            NativeSearchQueryBuilder queryBuilder = new NativeSearchQueryBuilder();
            queryBuilder.withQuery(synonymBoolQueryBuilder);
            queryBuilder.withPageable(PageRequest.of(0, 1)); // 设置分页，只获取第一个结果

            SearchHits<DrugAndIndicationIndex> results = null;
            try {
                results = RetryUtils.retry(
                        () -> elasticsearchRestTemplate.search(queryBuilder.build(), DrugAndIndicationIndex.class),
                        3,
                        1000,  // 每次重试间隔1秒
                        e -> true  // 对所有异常都重试，你也可以自定义条件，例如只对网络异常重试
                );
            } catch (Exception e) {
                log.error("获取同义词 药品表查询3次失败, error {}", e.getMessage(), e);
            }
            isMedicine = results != null && results.getTotalHits() > 0;
        }


        String synonymTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
        if (!GetSynonymUtil.judgeChinese(word)) {
            synonymTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
        }

        boolean isExists = mongoTemplate.exists(new Query(Criteria.where("entryTerms").is(word.toLowerCase())), EvidenceMesh.class, synonymTable);
        if (isExists && !exists) {
            wordList.add(word);
        } else if (!exists) {
            // 需要判断输入次word是不是 分类、商品、药其中之一
            // 输入词word 是分类 则不进行拆词 
            if (!classifyExists) {
                if (!isMedicine) {
                    try {
                        // 开始拆分输入词 分词逻辑
                        String feignPico = getPicoFeign.getPico(word);
                        JSONObject pico = JSONObject.parseObject(feignPico);
                        String resultPico = pico.getString("result");
                        if ("50200".equals(resultPico)) {
                            JSONObject picoJSONObject = pico.getJSONObject("pico");
                            JSONArray arrI = picoJSONObject.getJSONArray("I");
                            if (CollUtil.isNotEmpty(arrI)) {
                                wordList.add(arrI.getString(0));
                            }
                            JSONArray arrO = picoJSONObject.getJSONArray("O");
                            if (CollUtil.isNotEmpty(arrO)) {
                                wordList.add(arrO.getString(0));
                            }
                            JSONArray arrP = picoJSONObject.getJSONArray("P");
                            if (CollUtil.isNotEmpty(arrP)) {
                                wordList.add(arrP.getString(0));
                            }
                        }
                        log.info("药品快速综合评级getPico接口返回结果为{}", feignPico);
                    } catch (Exception e) {
                        log.error("调用getPicoFeign服务异常，启动后备分词逻辑，[{}]", e.getCause().getMessage());
                        // 调用分词器进行操作
                        if (GetSynonymUtil.judgeChinese(word)) {
                            wordList = paringPhraseFeign.parsingPhrase(word);
                        } else {
                            wordList = fineScreenFeign.jieBaParticiple(word);
                        }
                        if (CollUtil.isEmpty(wordList)) {
                            wordList.add(word);
                        }
                        log.info("药品快速综合评级使用非算法分词器分词结果为{}", wordList.toString());
                    }
                } else {
                    wordList.add(word);
                }
            } else {
                wordList.add(word);
            }
        }

        // 开始判断输入词的属性（只需要找到一个药品名称或者分类亦或商品+一个疾病名称）
        /**
         * 1. 药品
         * 2. 疾病
         * 3. 药品+疾病
         * 4. 药品分类
         * 5. 药品分类+疾病
         * 6. 商品名称
         * 7. 商品名称+疾病
         */
        // 药品名称
        String drugName = "";
        String drugNameTrans = "";
        List<String> drugNameSynonym = new ArrayList<>();
        List<String> drugNameSynonymZh = new ArrayList<>();
        List<String> drugNameSynonymEn = new ArrayList<>();
        List<String> drugNameSynonymOther = new ArrayList<>();
        // 商品名称
        String commodityName = "";
        String commodityNameTrans = "";
        List<String> commoditySynonym = new ArrayList<>();
        List<String> commoditySynonymZh = new ArrayList<>();
        List<String> commoditySynonymEn = new ArrayList<>();
        List<String> commoditySynonymOther = new ArrayList<>();
        // 药品分类
        String drugClassification = "";
        String drugClassificationTrans = "";
        List<String> drugClassificationSynonym = new ArrayList<>();
        List<String> drugClassificationSynonymZh = new ArrayList<>();
        List<String> drugClassificationSynonymEn = new ArrayList<>();
        List<String> drugClassificationSynonymOther = new ArrayList<>();
        // 疾病名称
        String diseaseName = "";
        String diseaseNameTrans = "";
        List<String> diseaseNameSynonym = new ArrayList<>();
        List<String> diseaseNameSynonymZh = new ArrayList<>();
        List<String> diseaseNameSynonymEn = new ArrayList<>();
        List<String> diseaseNameSynonymOther = new ArrayList<>();

        //
        if (!exists) {
            Map<String, String> transMap = VolcengineTransUtils.getTransResult(wordList);
            for (String s : wordList) {
                List<String> originalSynonym = new ArrayList<>();
                List<String> transSynonym = new ArrayList<>();
                List<String> otherSynonym = new ArrayList<>();

                String translate = transMap.get(s);
                if (StringUtils.isBlank(translate) || translate.equalsIgnoreCase(s)) {
                    if (GetSynonymUtil.judgeChinese(s)) {
                        translate = TranslateWordUtil.translateChineseToEnglish(s);
                    } else {
                        translate = TranslateWordUtil.translateEnglishToChinese(s);
                    }
                }
                // 1、如果是分类直接使用原词去找同义词
                // 2、其他情况需要使用翻译词和原词去查找同义词
                if (!classifyExists) {
                    boolean isUseTrans = GetSynonymUtil.getSynonym(s, originalSynonym, transSynonym, otherSynonym);
                    originalSynonym.add(s);  // 防止原词和翻译词都找不到 同义词 后 查询为药
                    transSynonym.add(translate); // 防止原词和翻译词都找不到 同义词 后 查询为药
                    if (!isUseTrans) {
                        // 翻译词的同义词
                        List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(translate);
                        transSynonym.addAll(synonymTrans);
                        transSynonym.add(translate); // 防止原词和翻译词都找不到 同义词 后 查询为药
                    }
                } else {
                    originalSynonym.add(s);
                    originalSynonym.addAll(GetSynonymUtil.getSynonym(originalSynonym));
                    originalSynonym = originalSynonym.stream().distinct().collect(Collectors.toList());
                }
                originalSynonym.remove("1-");
                transSynonym.remove("1-");
                List<String> searchList = new ArrayList<>();
                searchList.addAll(originalSynonym);
                searchList.addAll(transSynonym);
                searchList.addAll(otherSynonym);
                // app
                List<String> searchListZh = new ArrayList<>();
                List<String> searchListEn = new ArrayList<>();
                List<String> searchListOther = new ArrayList<>();
                if (GetSynonymUtil.judgeChinese(s)) {
                    searchListZh.addAll(originalSynonym);
                    searchListEn.addAll(transSynonym);
                    searchListOther.addAll(otherSynonym);
                    searchListZh.remove(s.toLowerCase());
                    searchListOther.remove(s.toLowerCase());
                    searchListEn.removeAll(Collections.singletonList(translate));
                    searchListEn.remove(translate.toLowerCase());

                } else {
                    searchListEn.addAll(originalSynonym);
                    searchListZh.addAll(transSynonym);
                    searchListOther.addAll(otherSynonym);
                    searchListEn.remove(s.toLowerCase());
                    searchListOther.remove(s.toLowerCase());
                    searchListZh.removeAll(Collections.singletonList(translate));
                    searchListZh.remove(translate.toLowerCase());
                }

                if (StringUtils.isBlank(drugName)
                        && StringUtils.isBlank(commodityName)
                        && StringUtils.isBlank(drugClassification) && !exists) {
                    // 判断是否药品分类
                    GradeAndDrugs gradeAndDrugs = mongoTemplate.findOne(new Query(Criteria.where("word").in(searchList)), GradeAndDrugs.class);
                    if (gradeAndDrugs != null) {
                        Integer codeLevel = gradeAndDrugs.getCodeLevel();
                        if (codeLevel < 4) {
                            searchListZh.remove("1-");
                            searchListEn.remove("1-");
                            searchList.remove("1-");
                            // 药品分类
                            drugClassification = s;
                            drugClassificationTrans = translate;
                            drugClassificationSynonym.addAll(searchList);
                            drugClassificationSynonym.remove(s.toLowerCase());
                            drugClassificationSynonym.remove(translate.toLowerCase());
                            // app
                            drugClassificationSynonymOther.addAll(searchListOther);
                            drugClassificationSynonymZh.addAll(searchListZh);
                            drugClassificationSynonymEn.addAll(searchListEn);
                            continue;
                        }
                    /*if (codeLevel == 4){
                        //药品名称
                        drugName = s;
                        drugNameTrans = translate;
                        drugNameSynonym.addAll(searchList);
                        //去除原词
                        drugNameSynonym.remove(s.toLowerCase());
                        drugNameSynonym.remove(translate.toLowerCase());
                        //app
                        drugNameSynonymZh.addAll(searchListZh);
                        drugNameSynonymEn.addAll(searchListEn);
                    }else {
                        //药品分类
                        drugClassification = s;
                        drugClassificationTrans = translate;
                        drugClassificationSynonym.addAll(searchList);
                        drugClassificationSynonym.remove(s.toLowerCase());
                        drugClassificationSynonym.remove(translate.toLowerCase());
                        //app
                        drugClassificationSynonymZh.addAll(searchListZh);
                        drugClassificationSynonymEn.addAll(searchListEn);
                    }
                    continue;*/
                    }

                    // 判断是不是商品
                    BoolQueryBuilder commodityBoolQueryBuilder = QueryBuilders.boolQuery();
                    List<String> condition = new ArrayList<>(Arrays.asList(s));
                    condition.forEach((con) -> {
                        MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(con, "commodityNameZh", "commodityNameEn");
                        multiMatchQueryBuilder.operator(Operator.AND);
                        multiMatchQueryBuilder.slop(0);
                        multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                        commodityBoolQueryBuilder.should().add(multiMatchQueryBuilder);
                    });

                    SearchHits<DrugAndIndicationIndex> commoditySearchResult = elasticsearchRestTemplate.search(new NativeSearchQuery(commodityBoolQueryBuilder), DrugAndIndicationIndex.class);
                    if (commoditySearchResult.getTotalHits() > CommonConstants.ZERO) {
                        commodityName = s;
                        commodityNameTrans = translate;
                        commoditySynonym.addAll(searchList);
                        // 去除原词
                        commoditySynonym.remove(s.toLowerCase());
                        commoditySynonym.remove(translate.toLowerCase());
                        // app
                        commoditySynonymOther.addAll(searchListOther);
                        commoditySynonymZh.addAll(searchListZh);
                        commoditySynonymEn.addAll(searchListEn);
                        continue;
                    }


                    // 判断是否是药品名称
                    BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
//                searchList.forEach(con -> {
                    MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(word, "drugName", "zhDrugName");
                    multiMatchQueryBuilder.operator(Operator.AND);
                    multiMatchQueryBuilder.slop(0);
                    multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilder.should().add(multiMatchQueryBuilder);
//                });
                    SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(new NativeSearchQuery(boolQueryBuilder), DrugAndIndicationIndex.class);
                    if (search.getTotalHits() > CommonConstants.ZERO) {
                        // 药品名称
                        drugName = s;
                        drugNameTrans = translate;
                        drugNameSynonym.addAll(searchList);
                        // 去除原词
                        drugNameSynonym.remove(s.toLowerCase());
                        drugNameSynonym.remove(translate.toLowerCase());
                        // app
                        drugNameSynonymOther.addAll(searchListOther);
                        drugNameSynonymZh.addAll(searchListZh);
                        drugNameSynonymEn.addAll(searchListEn);
                        continue;
                    }
                }

                if (StringUtils.isBlank(diseaseName)) {
                    // 当 当前词既不是药品名称和药品分类和商品时，判定它为疾病名称
                    diseaseName = s;
                    diseaseNameTrans = translate;
                    diseaseNameSynonym.addAll(searchList);
                    diseaseNameSynonym.remove(s.toLowerCase());
                    diseaseNameSynonym.remove(translate.toLowerCase());
                    // app
                    diseaseNameSynonymOther.addAll(searchListOther);
                    diseaseNameSynonymZh.addAll(searchListZh);
                    diseaseNameSynonymEn.addAll(searchListEn);
                }

            }
        } else {
            diseaseName = word;
            diseaseNameTrans = word;
        }

        // 开始拼接返回值并判断输入条件符合的类别
        // 药品名称存在为0，药品分类存在为1，都不存在为2 商品名称存在3
        int drugFlag = 2;
        if (StringUtils.isNotBlank(drugName)
                || StringUtils.isNotBlank(commodityName)
                || StringUtils.isNotBlank(drugClassification)) {
            // pc
            WordConditionVo wordConditionVo = new WordConditionVo();
            // appData
            Map<String, Object> appMap = new HashMap<>();

            if (StringUtils.isNotBlank(drugName)) {
                drugFlag = 0;
                wordConditionVo.setWord(drugName);
                wordConditionVo.setTrans(drugNameTrans);
                wordConditionVo.setSynonym(drugNameSynonym);
                wordConditionVo.setType(1);
                appMap.put("word", drugName);
                appMap.put("trans", drugNameTrans);
                appMap.put("synonymZh", drugNameSynonymZh);
                appMap.put("synonymEn", drugNameSynonymEn);
                appMap.put("synonymOther", drugNameSynonymOther);
                appMap.put("type", 1);
                appMap.put("synonym", drugNameSynonym);
            } else if (StringUtils.isNotBlank(commodityName)) {
                drugFlag = 3;
                wordConditionVo.setWord(commodityName);
                wordConditionVo.setTrans(commodityNameTrans);
                wordConditionVo.setSynonym(commoditySynonym);
                wordConditionVo.setType(4);
                appMap.put("word", commodityName);
                appMap.put("trans", commodityNameTrans);
                appMap.put("synonymZh", commoditySynonymZh);
                appMap.put("synonymEn", commoditySynonymEn);
                appMap.put("synonymOther", commoditySynonymOther);
                appMap.put("type", 4);
                appMap.put("synonym", drugNameSynonym);
            } else {
                drugFlag = 1;
                wordConditionVo.setWord(drugClassification);
                wordConditionVo.setTrans(drugClassificationTrans);
                wordConditionVo.setSynonym(drugClassificationSynonym);
                wordConditionVo.setType(2);
                appMap.put("word", drugClassification);
                appMap.put("trans", drugClassificationTrans);
                appMap.put("synonymZh", drugClassificationSynonymZh);
                appMap.put("synonymEn", drugClassificationSynonymEn);
                appMap.put("synonymOther", drugClassificationSynonymOther);
                appMap.put("type", 2);
                appMap.put("synonym", drugClassificationSynonym);
            }
            data.add(wordConditionVo);
            appData.add(appMap);
        }
        // 疾病存在为0，疾病不存在为1
        int diseaseFlag = 1;
        if (StringUtils.isNotBlank(diseaseName)) {
            // pc
            WordConditionVo wordConditionVo = new WordConditionVo();
            // appData
            Map<String, Object> appMap = new HashMap<>();
            diseaseFlag = 0;
            wordConditionVo.setWord(diseaseName);
            wordConditionVo.setTrans(diseaseNameTrans);
            wordConditionVo.setSynonym(diseaseNameSynonym);
            wordConditionVo.setType(3);
            data.add(wordConditionVo);
            appMap.put("word", diseaseName);
            appMap.put("trans", diseaseNameTrans);
            appMap.put("synonymZh", diseaseNameSynonymZh);
            appMap.put("synonymEn", diseaseNameSynonymEn);
            appMap.put("synonymOther", diseaseNameSynonymOther);
            appMap.put("type", 3);
            appMap.put("synonym", diseaseNameSynonym);
            appData.add(appMap);
        }
        // 开始判定后续类别 单药名1，单药分类2，单疾病3，药名+疾病4，药分类+疾病5，商品名6，商品名+疾病7
        int status = 0;
        if (drugFlag == 0 && diseaseFlag == 1) {
            status = 1;
        } else if (drugFlag == 1 && diseaseFlag == 1) {
            status = 2;
        } else if (drugFlag == 2 && diseaseFlag == 0) {
            status = 3;
        } else if (drugFlag == 0) {
            status = 4;
        } else if (drugFlag == 1) {
            status = 5;
        } else if (drugFlag == 3 && diseaseFlag == 0) {
            status = 7;
        } else if (drugFlag == 3) {
            status = 6;
        }


        if (status == 1) {

            BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder synonymBoolQueryBuilderx = QueryBuilders.boolQuery();
            BoolQueryBuilder synonymBoolQueryBuilderx1 = QueryBuilders.boolQuery();
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", word));  // 药品名称
            MultiMatchQueryBuilder drugName1 = QueryBuilders.multiMatchQuery(word, "drugName");
            drugName1.operator(Operator.AND);
            drugName1.slop(0);
            drugName1.type(MultiMatchQueryBuilder.Type.PHRASE);
            orBoolQueryBuilder.should().add(drugName1); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", word));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", word));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", word));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", word));  // 药品英文
            synonymBoolQueryBuilderx.must().add(orBoolQueryBuilder);
            synonymBoolQueryBuilderx1.must().add(orBoolQueryBuilder);
            synonymBoolQueryBuilderx.must().add(QueryBuilders.termQuery("drugCategory.keyword", "西药"));
            synonymBoolQueryBuilderx1.must().add(QueryBuilders.termQuery("drugCategory.keyword", "中成药"));
            NativeSearchQueryBuilder queryBuilder = new NativeSearchQueryBuilder();
            queryBuilder.withQuery(synonymBoolQueryBuilderx);
            queryBuilder.withPageable(PageRequest.of(0, 1)); // 设置分页，只获取第一个结果
            SearchHits<DrugAndIndicationIndex> results = elasticsearchRestTemplate.search(queryBuilder.build(), DrugAndIndicationIndex.class);
            NativeSearchQueryBuilder queryBuilder1 = new NativeSearchQueryBuilder();
            queryBuilder1.withQuery(synonymBoolQueryBuilderx1);
            queryBuilder1.withPageable(PageRequest.of(0, 1)); // 设置分页，只获取第一个结果
            SearchHits<DrugAndIndicationIndex> results1 = elasticsearchRestTemplate.search(queryBuilder1.build(), DrugAndIndicationIndex.class);
            if (results.getTotalHits() == 0 && results1.getTotalHits() != 0) {
                result.setDrugCategory("1");
            } else {
                result.setDrugCategory("0");
            }
        } else {
            result.setDrugCategory("0");
        }
        result.setStatus(status);
        result.setSearchId(UUID.randomUUID().toString());
        return result;
    }

    @Override
    public JSONArray history(Long userId) {
        JSONArray result = new JSONArray();

        // 查询指定用户的所有搜索历史记录，按regularType和timeStamp降序排序
        Query query = new Query(Criteria.where("userId").is(userId));
        query.with(Sort.by(Sort.Direction.DESC, "regularType", "timeStamp"));

        List<SearchHistory> searchHistories = mongoTemplate.find(query, SearchHistory.class);

        // 如果搜索历史记录超过10条，删除旧的记录，只保留最近的10条
        if (searchHistories.size() > 10) {
            // 获取需要删除的记录 (第10条之后的所有记录)
            List<SearchHistory> historiesToDelete = searchHistories.subList(10, searchHistories.size());

            // 提取需要删除的记录的ID
            List<String> idsToDelete = historiesToDelete.stream()
                    .map(SearchHistory::getId)
                    .collect(Collectors.toList());

            // 执行删除操作
            Query deleteQuery = new Query(Criteria.where("_id").in(idsToDelete));
            mongoTemplate.remove(deleteQuery, SearchHistory.class);

            // 保留前10条记录用于返回
            searchHistories = searchHistories.subList(0, 10);
        }

        // 格式化返回结果
        for (SearchHistory searchHistory : searchHistories) {
            JSONObject inner = new JSONObject();
            inner.put("historyId", searchHistory.getId());
            inner.put("word", searchHistory.getWord());

            Long timeStamp = searchHistory.getTimeStamp();
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            String formatData = format.format(new Date(timeStamp));
            inner.put("time", formatData);

            inner.put("status", searchHistory.getRegularType() != null && searchHistory.getRegularType() > 0 ? 1 : 0);

            result.add(inner);
        }

        return result;
    }



    @Override
    public Integer top(String historyId, Integer status) {
        SearchHistory searchHistory = mongoTemplate.findById(historyId, SearchHistory.class);
        if (searchHistory != null) {
            Update update = new Update();
            if (status == 1) {
                // 置顶
                update.set("regularType", System.currentTimeMillis());
            } else {
                // 取消置顶
                update.unset("regularType");
            }
            UpdateResult updateResult = mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(historyId)), update, SearchHistory.class);
            if (updateResult.getModifiedCount() > 0) {
                return 1;
            }
        }
        return 0;
    }

    @Override
    public Boolean deleteHistory(String historyId,String isAll,Long userId) {


        if("1".equals(isAll)){
            Query query = new Query(Criteria.where("userId").is(userId));
            DeleteResult deleteResult = mongoTemplate.remove(query, SearchHistory.class);
            return deleteResult.getDeletedCount() > 0;
        }
        DeleteResult deleteResult = mongoTemplate.remove(new Query(Criteria.where("_id").is(historyId)), SearchHistory.class);
        return deleteResult.getDeletedCount() > 0;
    }

    @Override
    public PageVo<Map<String, String>> disease(ConditionVo conditionVo) {
        PageVo<Map<String, String>> pageVo = new PageVo<>();
        // 全部疾病名称
        List<Map<String, String>> list = new ArrayList<>();
        // 开始判定后续类别 单药名1，单药分类2，单疾病3，药名+疾病4，药分类+疾病5 商品6 商品+疾病7
        Integer status = conditionVo.getStatus();
        // 当前检索词的类型：单药名1，单药分类2，单疾病3
        List<WordConditionVo> data = conditionVo.getData();
        if (status == 3 || status == 4 || status == 5 || status == 7) {


            // 用户输入条件包含疾病
            for (WordConditionVo datum : data) {
                Integer type = datum.getType();
                String word = datum.getWord();
//                Pattern pattern = Pattern.compile("^" + Pattern.quote(word) + "$", Pattern.CASE_INSENSITIVE);
//                boolean exists = mongoTemplate.exists(new Query(Criteria.where("abbreviation_english_name_of_the_disease").regex(pattern)), "disease_abbreviation");
//                if (exists) {
//                    List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("abbreviation_english_name_of_the_disease").regex(pattern)), JSONObject.class, "disease_abbreviation");
//                    if (jsonObjects.size() > 0) {
//                        for (JSONObject jsonObject : jsonObjects) {
//                            Map<String, String> map = new HashMap<>();
//                            map.put("zh", jsonObject.getString("disease_name_chinese"));
//                            list.add(map);
//                        }
//                    }
//                }

                if (type == 3) {
                    Map<String, String> map = new HashMap<>();
                    if (StringUtils.isNotBlank(word)) {
                        if (GetSynonymUtil.judgeChinese(word)) {
                            map.put("zh", word);
                        } else {
                            map.put("en", word);
                        }
                    }
//                    String trans = datum.getTrans();
//                    if (StringUtils.isNotBlank(trans)){
//                        if (GetSynonymUtil.judgeChinese(trans)){
//                            map.put("zh", trans);
//                        }else {
//                            map.put("en", trans);
//                        }
//                    }
                    list.add(map);
                    // 不再将同义词显示到疾病列表
                    /*List<String> synonym = datum.getSynonym();
                    if (CollUtil.isNotEmpty(synonym)){
                        for (String s : synonym) {
                            Map<String, String> synonymMap = new HashMap<>();
                            if (GetSynonymUtil.judgeChinese(s)){
                                synonymMap.put("zh", s);
                            }else {
                                synonymMap.put("en", s);
                            }
                            list.add(synonymMap);
                        }
                    }*/
                    break;
                }
            }
        } else {
            WordConditionVo wordConditionVo = data.get(0);
            List<String> drugs = new ArrayList<>();
            // 单药名
            if (status == 1) {
                String word = wordConditionVo.getWord();
                if (StringUtils.isNotBlank(word)) {
                    drugs.add(word);
                }
                String trans = wordConditionVo.getTrans();
                if (StringUtils.isNotBlank(trans)) {
                    drugs.add(trans);
                }
                List<String> synonym = wordConditionVo.getSynonym();
                if (CollUtil.isNotEmpty(synonym)) {
                    drugs.addAll(synonym);
                }
            }

            if (status == 2) {
                // 单药品分类
                String word = wordConditionVo.getWord();
                if (StringUtils.isNotBlank(word)) {
                    List<String> list1 = searchDrugs(word);
                    if (CollUtil.isNotEmpty(list1)) {
                        drugs.addAll(list1);
                    }
                }
                String trans = wordConditionVo.getTrans();
                if (StringUtils.isNotBlank(trans)) {
                    List<String> list1 = searchDrugs(trans);
                    if (CollUtil.isNotEmpty(list1)) {
                        drugs.addAll(list1);
                    }
                }
                List<String> searchDrugs = conditionVo.getDrugs();
                if (CollUtil.isNotEmpty(searchDrugs)) {
                    drugs.retainAll(searchDrugs);
                }
            }

            List<String> commodities = new ArrayList<>();
            // 商品
            if (status == 6) {
                String word = wordConditionVo.getWord();
                if (StringUtils.isNotBlank(word)) {
                    commodities.add(word);
                }
                String trans = wordConditionVo.getTrans();
                if (StringUtils.isNotBlank(trans)) {
                    commodities.add(trans);
                }
                List<String> synonym = wordConditionVo.getSynonym();
                if (CollUtil.isNotEmpty(synonym)) {
                    commodities.addAll(synonym);
                }
            }

            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            if (CollUtil.isNotEmpty(commodities)) {
                for (String commodity : commodities) {
                    MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(commodity, "commodityNameZh", "commodityNameEn");
                    multiMatchQueryBuilder.operator(Operator.AND);
                    multiMatchQueryBuilder.slop(0);
                    multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilder.should().add(multiMatchQueryBuilder);
                }
            }

            if (CollUtil.isNotEmpty(drugs)) {
                for (String drug : drugs) {
                    MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "drugName", "zhDrugName");
                    multiMatchQueryBuilder.operator(Operator.AND);
                    multiMatchQueryBuilder.slop(0);
                    multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilder.should().add(multiMatchQueryBuilder);
                }
            }

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            nativeSearchQuery.setTrackTotalHits(true);
            long count = elasticsearchRestTemplate.count(nativeSearchQuery, DrugAndIndicationIndex.class);
            if (count > 0) {
                Set<Map<String, String>> set = new HashSet<>();
                int num = (int) (count % 20 == 0 ? count / 20 : count / 20 + 1);
                for (int i = 0; i < num; i++) {
                    nativeSearchQuery.setPageable(PageRequest.of(i, 20));
                    SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
                    for (SearchHit<DrugAndIndicationIndex> searchHit : search) {
                        DrugAndIndicationIndex content = searchHit.getContent();
                        List<String> diseaseZh = content.getDiseaseZh();
                        if (CollUtil.isNotEmpty(diseaseZh)) {
                            for (String disease : diseaseZh) {
                                Map<String, String> map = new HashMap<>();
                                map.put("zh", disease.trim());
                                set.add(map);
                            }
                        }
                    }
                }
                list.addAll(set);
            }
        }

        // 判断用户是否在进行了二次检索
        String searchWord = conditionVo.getSearchWord();
        if (StringUtils.isNotBlank(searchWord)) {
            searchWord = searchWord.toLowerCase();
            List<Map<String, String>> afterSearch = new ArrayList<>();
            for (Map<String, String> map : list) {
                String zh = map.get("zh");
                if (StringUtils.isNotBlank(zh)) {
                    if (zh.contains(searchWord)) {
                        zh = zh.replaceAll(searchWord, "<span>" + searchWord + "</span>");
                        map.put("zh", zh.trim());
                        afterSearch.add(map);
                    }
                }
                String en = map.get("en");
                if (StringUtils.isNotBlank(en)) {
                    if (en.contains(searchWord)) {
                        en = en.replaceAll(searchWord, "<span>" + searchWord + "</span>");
                        map.put("en", en.trim());
                        afterSearch.add(map);
                    }
                }
            }
            list = afterSearch;
        }

        Integer pageSize = conditionVo.getPageSize();
        pageVo.setPageSize(pageSize);
        Integer pageNum = conditionVo.getPageNum();
        pageVo.setPageNum(pageNum);
        long total = list.size();
        pageVo.setTotal(total);

        // 开始计算每页内容
        List<Map<String, String>> pageList = new ArrayList<>();
        if ((long) pageSize * pageNum > total) {
            pageList.addAll(list.subList((pageNum - 1) * pageSize, (int) total));
        } else {
            pageList.addAll(list.subList((pageNum - 1) * pageSize, pageNum * pageSize));
        }
        pageVo.setList(pageList);
        pageVo.setPages((int) (total % pageSize == 0 ? total / pageSize : total / pageSize + 1));
        pageVo.setType(3);
        return pageVo;
    }

    @Override
    public PageVo<DrugAndIndicationVo> drugAndIndication(ConditionVo conditionVo) {
        {
            // 生成量表内容
            if (StringUtils.isNotEmpty(conditionVo.getScaleId())) {
                vaeService.guidePanelFor(conditionVo.getScaleId());
            }

        }


        PageVo<DrugAndIndicationVo> pageVo = new PageVo<>();
        List<DrugAndIndicationVo> list = new ArrayList<>();
        ArrayList<DrugAndIndicationVo> drugAndIndicationVos = new ArrayList<>();
        // 开始判定后续类别 单药名1，单药分类2，单疾病3，药名+疾病4，药分类+疾病5，商品6，商品+分类7
        Integer status = conditionVo.getStatus();
        // 当前检索词的类型：单药名1，单药分类2，单疾病3，单商品4
        List<WordConditionVo> data = conditionVo.getData();
        // 检索条件
        List<String> words = new ArrayList<>();
        // 检索条件是商品名的时候 6 商品名  7 商品名+疾病
        if (status == 6 || status == 7) {
            pageVo.setType(4);
            for (WordConditionVo datum : data) {
                Integer type = datum.getType();
                if (type == 4) {
                    String word = datum.getWord();
                    if (StringUtils.isNotBlank(word)) {
                        words.add(word);
                    }
                    String trans = datum.getTrans();
                    if (StringUtils.isNotBlank(trans)) {
                        words.add(trans);
                    }
                    List<String> synonym = datum.getSynonym();
                    if (CollUtil.isNotEmpty(synonym)) {
                        words.addAll(synonym);
                    }
                    break;
                }
            }
        }

        if (status == 1 || status == 4) {
            pageVo.setType(1);
            // 药品名称
            for (WordConditionVo datum : data) {
                Integer type = datum.getType();
                if (type == 1) {
                    String word = datum.getWord();
                    if (StringUtils.isNotBlank(word)) {
                        words.add(word);
                    }
                    String trans = datum.getTrans();
                    if (StringUtils.isNotBlank(trans)) {
                        words.add(trans);
                    }
                    List<String> synonym = datum.getSynonym();
                    if (CollUtil.isNotEmpty(synonym)) {
                        words.addAll(synonym);
                    }
                    break;
                }
            }
        }

        if (status == 2 || status == 5) {
            pageVo.setType(2);
            // 药品分类
            WordConditionVo wordConditionVo = data.get(0);
            String word = wordConditionVo.getWord();
            if (StringUtils.isNotBlank(word)) {
                List<String> list1 = searchDrugs(word);
                if (CollUtil.isNotEmpty(list1)) {
                    words.addAll(list1);
                }
            }
            String trans = wordConditionVo.getTrans();
            if (StringUtils.isNotBlank(trans)) {
                List<String> list1 = searchDrugs(trans);
                if (CollUtil.isNotEmpty(list1)) {
                    words.addAll(list1);
                }
            }
            // 对words进行去重处理
            Set<String> set = new HashSet<>(words);
            words = new ArrayList<>(set);
            pageVo.setDrugs(words);
            List<String> drugs = conditionVo.getDrugs();
            if (CollUtil.isNotEmpty(drugs)) {
                words.retainAll(drugs);
            }
        }

        if (status == 3) {
            pageVo.setType(3);
            // 单个疾病
            for (WordConditionVo datum : data) {
                String word = datum.getWord();
                Integer type = datum.getType();
//                Pattern pattern = Pattern.compile("^" + Pattern.quote(word) + "$", Pattern.CASE_INSENSITIVE);
//                boolean exists = mongoTemplate.exists(new Query(Criteria.where("abbreviation_english_name_of_the_disease").regex(pattern)), "disease_abbreviation");
//                if (exists) {
//                    List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("abbreviation_english_name_of_the_disease").regex(pattern)), JSONObject.class, "disease_abbreviation");
//                    if (jsonObjects.size() > 0) {
//                        Map<String, String> map = new HashMap<>();
//                        for (JSONObject jsonObject : jsonObjects) {
//                            words.add(jsonObject.getString("disease_name_chinese"));
//                        }
//                    }
//                }

                if (type == 3) {

                    if (StringUtils.isNotBlank(word)) {
                        words.add(word);
                    }
                    String trans = datum.getTrans();
                    if (StringUtils.isNotBlank(trans)) {
                        words.add(trans);
                    }
                    List<String> synonym = datum.getSynonym();
                    if (CollUtil.isNotEmpty(synonym)) {
                        words.addAll(synonym);
                    }
                    break;
                }
            }
        }

        // 根据得到的检索词进行判定检索
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();

        switch (pageVo.getType()) {
            case 1:
            case 2:
                for (String word : words) {
                    MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(word, "drugName", "zhDrugName");
                    multiMatchQueryBuilder.operator(Operator.AND);
                    multiMatchQueryBuilder.slop(0);
                    multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilder.should().add(multiMatchQueryBuilder);
                }
                break;
            case 3:
                for (String word : words) {
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("disease", word);
                    matchQueryBuilder.operator(Operator.AND);
                    boolQueryBuilder.should().add(matchQueryBuilder);
                }
                break;
            case 4:
                for (String word : words) {
                    MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(word, "commodityNameZh", "commodityNameEn");
                    multiMatchQueryBuilder.operator(Operator.AND);
                    multiMatchQueryBuilder.slop(0);
                    multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilder.should().add(multiMatchQueryBuilder);
                }
                break;
            default:
                break;
        }

//      此处判定是否有药物不良反应、用法用量、适应症
//        BoolQueryBuilder mustQuery = QueryBuilders.boolQuery();
//        mustQuery.should().add(QueryBuilders.existsQuery("adverseReaction"));
//        mustQuery.should().add(QueryBuilders.existsQuery("usageAndDosage"));
//        mustQuery.should().add(QueryBuilders.existsQuery("indications"));
//        mustQuery.minimumShouldMatch(1);


        // 判断用户是否输入二次检索
        String searchWord = conditionVo.getSearchWord().trim();
        NativeSearchQuery nativeSearchQuery;
        BoolQueryBuilder boolQuery = QueryBuilders.boolQuery();
        if (StringUtils.isNotBlank(searchWord)) {

            boolQuery.must().add(boolQueryBuilder);
            // 用户检索条件的拼接
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchWord, "zhDrugName", "indication", "manufacturer", "specifications", "commodityNameZh", "commodityNameEn"); // 药名、适应症、厂家、规格
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.slop(0);
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            boolQuery.must().add(multiMatchQueryBuilder);
//            boolQuery.must().add(mustQuery);
        } else {

            boolQueryBuilder.minimumShouldMatch(1);
            boolQuery.must().add(boolQueryBuilder); // 确保drugName或zhDrugName中至少有一个匹配
//            finalQuery.must().add(mustQuery); // 确保至少有一个字段存在
        }
        // 修改的内容提前显示
        Query query = new Query(Criteria.where("searchId").is(conditionVo.getSearchId()));
        List<DrugAddDto> drugAddDtos = mongoTemplate.find(query, DrugAddDto.class);
        ArrayList<String> strings = new ArrayList<>();
        if (CollUtil.isNotEmpty(drugAddDtos)) {
            // 创建 SearchSourceBuilder 并添加查询、过滤器及排序
            drugAddDtos.forEach(drugAddDto -> {
                strings.add(drugAddDto.getDrugId());
            });


        }

        nativeSearchQuery = new NativeSearchQuery(boolQuery);
        SearchHits<DrugAndIndicationIndex> searchx = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);


        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ids", strings);
        map.put("keyword", conditionVo.getData().get(0).getWord());
        Script script = new Script(ScriptType.INLINE, "painless",
                "if (params.ids.indexOf(doc['id.keyword'].getValue()) >= 0) { return 100000; } " +
                        "else { " +
                        "    boolean field1ExistsAndHasValue = doc.containsKey('integrityScore') && doc['integrityScore'].size() > 0 && doc['integrityScore'].value > 0;" +
                        "    if (field1ExistsAndHasValue) { " +
                        "        def scoreValue = doc['integrityScore'].value instanceof Integer ? (Integer) doc['integrityScore'].value : 0;" +
                        "        return 1000;" +
                        "    } " +
                        "    if (doc.containsKey('zhDrugName.keyword') && doc['zhDrugName.keyword'].value.toLowerCase().equals(params.keyword.toLowerCase())) { " +
                        "        return 500;" +
                        "    } " +
                        "    if (doc.containsKey('drugZh.keyword') && doc['drugZh.keyword'].value.toLowerCase().equals(params.keyword.toLowerCase())) { " +
                        "        return 500;" +
                        "    } " +
                        "    return 1;" +
                        "}",
                map);


        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(boolQuery, scriptScoreFunctionBuilder);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.FIRST);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setMaxResults(1000);


        SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);

        // key = 产品名称-厂家-规格  value = id

        for (SearchHit<DrugAndIndicationIndex> indexSearchHit : search) {
            DrugAndIndicationIndex content = indexSearchHit.getContent();

            DrugInfoNew drugAndIndication = mongoTemplate.findById(content.getId(), DrugInfoNew.class);


            if (drugAndIndication != null) {
                boolean isbn = true;
                // 判断是否使用高亮

                if (StringUtils.isNotBlank(searchWord)) {
                    // 标题
                    String drugName = drugAndIndication.getDrugName();
                    if (StringUtils.isNotBlank(drugName)) {
                        drugName = drugName.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setDrugName(drugName);
                    }
                    // 适应症
                    String indication = drugAndIndication.getIndication();
                    if (StringUtils.isNotBlank(indication)) {
                        indication = indication.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setIndication(indication);
                    }

                    // 中文商品名称
                    String communityNameZh = drugAndIndication.getCommunityNameZh();
                    if (StringUtils.isNotBlank(communityNameZh)) {
                        communityNameZh = communityNameZh.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setCommunityNameZh(communityNameZh);
                    }
                    // 英文商品名称
                    String communityNameEn = drugAndIndication.getCommunityNameEn();
                    if (StringUtils.isNotBlank(communityNameEn)) {
                        communityNameEn = communityNameEn.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setCommunityNameEn(communityNameEn);
                    }


                    // 商家
                    String manufacturer = drugAndIndication.getManufacturer();
                    if (StringUtils.isNotBlank(manufacturer)) {
                        manufacturer = manufacturer.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setManufacturer(manufacturer);
                    }
                    // 包装规格
                    String specifications = drugAndIndication.getSpecifications();
                    if (StringUtils.isNotBlank(specifications)) {
                        specifications = specifications.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setSpecifications(specifications);
                    }
                }


                String register = drugAndIndication.getRegister();
                if (register != null) {

                    // Redis 中没有命中，从 MongoDB 查询
                    DrugInstMini approveCode = mongoTemplate.findOne(
                            new Query(Criteria.where("approveCode").is(register)),
                            DrugInstMini.class
                    );

                    if (ObjectUtil.isNotEmpty(approveCode)) {
                        if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                            drugAndIndication.setIndications(delHTMLTag(approveCode.getIndication()));
                        }
                        if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                            drugAndIndication.setPdf(approveCode.getPdf());
                        }


                        isbn = false;

                    }

                }


//                if (ObjectUtil.isNotEmpty(drugAndIndication.getDrugZh())) {
//                    JSONObject evaluationMedicine = getHeliYongYao(drugAndIndication.getDrugZh());
//                    if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
//                        if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
//                            drugAndIndication.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));
//
//                        }
//                        if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
//                            drugAndIndication.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));
//
//                        }
//
//                        if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
//                            drugAndIndication.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
//                        }
//                        if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
//                            drugAndIndication.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
//                        }
//
//                    }
//                }


                DrugAndIndicationVo drugAndIndicationVo = FormatUtil.indicationFormatV2(drugAndIndication);
                ArrayList<String> grav = new ArrayList<>();
                if (strings.contains(drugAndIndicationVo.getId())) {

                    for (DrugAddDto drugAddDto : drugAddDtos) {
                        if (drugAddDto.getDrugId().equals(drugAndIndicationVo.getId())) {
                            if (StringUtils.isNotEmpty(drugAddDto.getCommunityNameZh()) && !drugAddDto.getCommunityNameZh().equals(drugAndIndication.getCommunityNameZh())) {
                                grav.add("commodityNameZh");
                                drugAndIndicationVo.setCommodityNameZh(drugAddDto.getCommunityNameZh());
                            }
                            if (StringUtils.isNotEmpty(drugAddDto.getSpecifications()) && !drugAddDto.getSpecifications().equals(drugAndIndication.getSpecifications())) {
                                grav.add("specifications");
                                drugAndIndicationVo.setSpecifications(drugAddDto.getSpecifications());
                            }
                            if (StringUtils.isNotEmpty(drugAddDto.getIndication()) && !drugAddDto.getIndication().equals(drugAndIndication.getIndication())) {
                                grav.add("Indication");
                                drugAndIndicationVo.setIndication(drugAddDto.getIndication());
                            }

                        }
                    }
                }


                drugAndIndicationVo.setGrav(grav);
                drugAndIndicationVo.setIsbn(isbn);
                list.add(drugAndIndicationVo);


            }
        }
//        }
        pageVo.setPageSize(conditionVo.getPageSize());
        pageVo.setPageNum(conditionVo.getPageNum());
        long totalHits = search.getTotalHits();
        pageVo.setTotal(totalHits);
        pageVo.setPages((int) (totalHits % conditionVo.getPageSize() == 0 ? totalHits / conditionVo.getPageSize() : totalHits / conditionVo.getPageSize() + 1));
        pageVo.setList(list);
        return pageVo;
    }

    @Override
    public JSONObject judge(DrugAndDiseaseDto drugAndDiseaseDto) {
        JSONObject result = new JSONObject();
        List<String> diseases = drugAndDiseaseDto.getDiseases();
        List<String> drugIds = drugAndDiseaseDto.getDrugIds();
        if (diseases.size() > 1 || drugIds.size() > 1) {
            JSONArray array = new JSONArray();
            if (drugIds.size() > 1) {
                // 药品数量大于1
                result.put("status", 1);
            } else {
                // 疾病数量大于1
                result.put("status", 2);
            }
            for (String disease : diseases) {
                for (String drugId : drugIds) {
                    DrugAndIndication drugAndIndication = mongoTemplate.findById(drugId, DrugAndIndication.class);
                    if (drugAndIndication != null) {
                        DrugAndIndicationVo drugAndIndicationVo = FormatUtil.indicationFormat(drugAndIndication);
                        String title = drugAndIndicationVo.getTitle();
                        JSONObject inner = new JSONObject();
                        inner.put("drug", title);
                        inner.put("disease", disease);
                        array.add(inner);
                    }
                    /*DrugAndIndicationIndex drugAndIndicationIndex = elasticsearchRestTemplate.get(drugId, DrugAndIndicationIndex.class);
                    if (drugAndIndicationIndex != null){
                        List<String> drugName = drugAndIndicationIndex.getDrugName();
                        JSONObject inner = new JSONObject();
                        inner.put("drug", drugName.get(0));
                        inner.put("disease", disease);
                        array.add(inner);
                    }*/
                }
            }
            result.put("data", array);
        } else {
            result.put("status", 0);
        }
        return result;
    }

    @Override
    public PageVo<DrugAndPriceVo> drugAndPrice(ReferenceDrugDto referenceDrugDto) {

        if (StringUtils.isEmpty(referenceDrugDto.getDisease())) {
            return drugAndPriceTr(referenceDrugDto);
        }

        PageVo<DrugAndPriceVo> pageVo = new PageVo<>();
        Integer pageNum = referenceDrugDto.getPageNum();
        pageVo.setPageNum(pageNum);
        Integer pageSize = referenceDrugDto.getPageSize();
        pageVo.setPageSize(pageSize);

        // 大的查询bool
        BoolQueryBuilder overAll = QueryBuilders.boolQuery();

        // 开始根据疾病查询药品适应症表
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        String drugId = referenceDrugDto.getDrugId();
        IdsQueryBuilder idsQueryBuilder = QueryBuilders.idsQuery().addIds(drugId);
        boolQueryBuilder.mustNot().add(idsQueryBuilder);

        TermQueryBuilder termQuery = QueryBuilders.termQuery("disease.keyword", referenceDrugDto.getDisease());
        // 开始统计全部药品名称
        List<String> drugNames = new ArrayList<>();
        NativeSearchQuery statisticsQuery = new NativeSearchQuery(termQuery);
        // 五级中文
        statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugNames.keyword").size(30));
        SearchHits<DrugAndIndicationIndex> indexSearchHits = null;
        Aggregations aggregations = null;
        try {
            NativeSearchQuery finalStatisticsQuery = statisticsQuery;
            indexSearchHits = RetryUtils.retry(
                    () -> elasticsearchRestTemplate.search(finalStatisticsQuery, DrugAndIndicationIndex.class),
                    3,
                    1000,
                    e -> true
            );
            aggregations = indexSearchHits.getAggregations();
        } catch (Exception e) {
            log.error("参比药品查询失败{}", e.getMessage(), e);
        }
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("zhDrugName");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                String string = bucket.getKey().toString();
                drugNames.add(string);
            }
        } else {
            statisticsQuery = new NativeSearchQuery(termQuery);
            // 五级英文
            statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("enDrugNames.keyword").size(30));
            indexSearchHits = elasticsearchRestTemplate.search(statisticsQuery, DrugAndIndicationIndex.class);
            aggregations = indexSearchHits.getAggregations();
            if (aggregations != null) {
                Aggregation aggregation = aggregations.get("zhDrugName");
                List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                for (Terms.Bucket bucket : buckets) {
                    String string = bucket.getKey().toString();
                    drugNames.add(string);
                }
            } else {
                statisticsQuery = new NativeSearchQuery(termQuery);
                // 产品名称
                statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugName.keyword").size(30));
                indexSearchHits = elasticsearchRestTemplate.search(statisticsQuery, DrugAndIndicationIndex.class);
                aggregations = indexSearchHits.getAggregations();
                if (aggregations != null) {
                    Aggregation aggregation = aggregations.get("zhDrugName");
                    List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                    for (Terms.Bucket bucket : buckets) {
                        String string = bucket.getKey().toString();
                        drugNames.add(string);
                    }
                }
            }
        }
        pageVo.setReferenceDrug(drugNames);
        // 1.查找治疗指定病的药
        boolQueryBuilder.must().add(termQuery);

        // 用户勾选了页面参比药物分类
        if (CollUtil.isNotEmpty(referenceDrugDto.getDrugs())) {
            BoolQueryBuilder inner = QueryBuilders.boolQuery();
            List<String> drugList = referenceDrugDto.getDrugs();
            for (String s : drugList) {
                MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("drugName", s);
                matchQueryBuilder.operator(Operator.AND);
                inner.should().add(matchQueryBuilder);
            }
            boolQueryBuilder.must().add(inner);
        }

        // 拼接用户单独检索条件
        String searchWord = referenceDrugDto.getSearchWord();
        if (StringUtils.isNotBlank(searchWord)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchWord, "zhDrugName", "manufacturer", "specifications");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.slop(0);
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            boolQueryBuilder.must().add(multiMatchQueryBuilder);
        }

        overAll.should().add(boolQueryBuilder);

        // 2. 查询 同药品 不同规格不同剂型、不同厂家的药品需要作为其参比药品
        NativeSearchQuery idNativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
        idNativeSearchQuery.setTrackTotalHits(true);
        SearchHits<DrugAndIndicationIndex> drugAndIndicationIndex = elasticsearchRestTemplate.search(idNativeSearchQuery, DrugAndIndicationIndex.class);
        if (drugAndIndicationIndex.getTotalHits() > 0) {
            List<String> zhDrugNames = drugAndIndicationIndex.getSearchHits().get(0).getContent().getZhDrugNames();
            List<String> enDrugNames = drugAndIndicationIndex.getSearchHits().get(0).getContent().getEnDrugNames();
            if (CollUtil.isEmpty(zhDrugNames)) {
                zhDrugNames.add(drugAndIndicationIndex.getSearchHits().get(0).getContent().getZhDrugName());
            }
            List<String> zhAndEnNames = (List<String>) CollUtil.union(zhDrugNames, enDrugNames);

            Criteria criteria = new Criteria();
            criteria.orOperator(Criteria.where("level5").in(zhAndEnNames), Criteria.where("drugName").in(zhAndEnNames));

            Query query = new Query(criteria);
            query.with(Sort.by(Sort.Order.desc("level")));
            List<JSONObject> jsonObjects = mongoTemplate.find(query, JSONObject.class, "drug_category");
            if (CollUtil.isNotEmpty(jsonObjects)) {
                JSONObject jsonObject1 = jsonObjects.get(0);
                List<String> names = new ArrayList<>();
                if ("1".equals(jsonObject1.getString("level"))) {
                    Criteria criteria1 = new Criteria();
                    criteria1.andOperator(
                            Criteria.where("level1").in(jsonObject1.getString("level1")),
                            Criteria.where("type").is(jsonObject1.getString("type"))
                    );
                    Query query1 = new Query(criteria1);
                    List<JSONObject> jsonObjectsx = mongoTemplate.find(query1, JSONObject.class, "drug_category");
                    if (CollUtil.isNotEmpty(jsonObjectsx)) {
                        for (JSONObject jsonObject : jsonObjectsx) {
                            String string = jsonObject.getString("level5");
                            if (StringUtils.isNotBlank(string)) {
                                names.add(string);
                            } else {
                                names.add(jsonObject.getString("drugName"));
                            }
                        }
                    }
                } else if ("2".equals(jsonObject1.getString("level"))) {
                    Criteria criteria1 = new Criteria();
                    criteria1.andOperator(
                            Criteria.where("level2").in(jsonObject1.getString("level2")),
                            Criteria.where("level1").in(jsonObject1.getString("level1")),
                            Criteria.where("type").is(jsonObject1.getString("type"))
                    );
                    Query query1 = new Query(criteria1);
                    List<JSONObject> jsonObjectsx = mongoTemplate.find(query1, JSONObject.class, "drug_category");
                    if (CollUtil.isNotEmpty(jsonObjectsx)) {
                        for (JSONObject jsonObject : jsonObjectsx) {
                            String string = jsonObject.getString("level5");
                            if (StringUtils.isNotBlank(string)) {
                                names.add(string);
                            } else {
                                names.add(jsonObject.getString("drugName"));
                            }
                        }
                    }

                } else if ("3".equals(jsonObject1.getString("level"))) {
                    Criteria criteria1 = new Criteria();
                    criteria1.andOperator(
                            Criteria.where("level3").in(jsonObject1.getString("level3")),
                            Criteria.where("level2").in(jsonObject1.getString("level2")),
                            Criteria.where("level1").in(jsonObject1.getString("level1")),
                            Criteria.where("type").is(jsonObject1.getString("type"))
                    );
                    Query query1 = new Query(criteria1);
                    List<JSONObject> jsonObjectsx = mongoTemplate.find(query1, JSONObject.class, "drug_category");
                    if (CollUtil.isNotEmpty(jsonObjectsx)) {
                        for (JSONObject jsonObject : jsonObjectsx) {
                            String string = jsonObject.getString("level5");
                            if (StringUtils.isNotBlank(string)) {
                                names.add(string);
                            } else {
                                names.add(jsonObject.getString("drugName"));
                            }
                        }
                    }

                } else if ("4".equals(jsonObject1.getString("level"))) {
                    Criteria criteria1 = new Criteria();
                    criteria1.andOperator(
                            Criteria.where("level4").in(jsonObject1.getString("level4")),
                            Criteria.where("level1").in(jsonObject1.getString("level1")),
                            Criteria.where("level2").in(jsonObject1.getString("level2")),
                            Criteria.where("level3").in(jsonObject1.getString("level3")),
                            Criteria.where("type").is(jsonObject1.getString("type"))
                    );
                    Query query1 = new Query(criteria1);
                    List<JSONObject> jsonObjectsx = mongoTemplate.find(query1, JSONObject.class, "drug_category");
                    if (CollUtil.isNotEmpty(jsonObjectsx)) {
                        for (JSONObject jsonObject : jsonObjectsx) {
                            String string = jsonObject.getString("level5");
                            if (StringUtils.isNotBlank(string)) {
                                names.add(string);
                            } else {
                                names.add(jsonObject.getString("drugName"));
                            }
                        }
                    }
                }
                names.remove("");
                //先去重
                names = (List<String>) CollUtil.union(names, names);

                zhAndEnNames = (List<String>) CollUtil.union(zhAndEnNames, names);
            }

            // 与此药品同属于一个最小药品分类的其他药品，均要作为其参比药品。（根据药理学分类：一级到四级，取最小分类）normalWord五级中文  successfully
            // 目前只找到了最高三级的分类，如果三级分类还没有 需要再添加逻辑 
//            List<GradeAndDrugs> gradeAndDrugs = MongoUtil.mongo.find(new Query(Criteria.where("normalWord").in(zhAndEnNames).andOperator(Criteria.where("codeLevel").is(4))), GradeAndDrugs.class);
//            if (CollUtil.isNotEmpty(gradeAndDrugs)) {
//                // 四级分类的code
//                List<String> fourCodeLevelList = gradeAndDrugs.stream().map(item -> StringUtils.substringBeforeLast(item.getCode(), CommonConstants.SPOT)).collect(Collectors.toList());
//                fourCodeLevelList = fourCodeLevelList.stream().distinct().collect(Collectors.toList());
//                List<GradeAndDrugs> fourCodeLevelGradeAndDrugs = MongoUtil.mongo.find(new Query(Criteria.where("code").in(fourCodeLevelList)), GradeAndDrugs.class);
//                // 找到的五级中文英文的名字
//                List<String> fiveNames = new ArrayList<>();
//                if (CollUtil.isEmpty(fourCodeLevelGradeAndDrugs)) {
//                    // 三级分类的code
//                    List<String> threeCodeLevelList = fourCodeLevelList.stream().map(item -> StringUtils.substringBeforeLast(item, CommonConstants.SPOT)).collect(Collectors.toList());
//                    threeCodeLevelList = threeCodeLevelList.stream().distinct().collect(Collectors.toList());
//                    List<Criteria> criteriaList = new ArrayList<>();
//                    for (String code : threeCodeLevelList) {
//                        Criteria criteria = Criteria.where("code").regex("^" + code);
//                        criteriaList.add(criteria);
//                    }
//                    Criteria criteria = new Criteria();
//                    criteria.orOperator(criteriaList.toArray(new Criteria[0]));
//                    criteria.andOperator(Criteria.where("codeLevel").is(4));
//                    List<GradeAndDrugs> threeGradeAndDrugs = MongoUtil.mongo.find(new Query(criteria), GradeAndDrugs.class);
//                    threeGradeAndDrugs.stream().map(item -> fiveNames.addAll(item.getNormalWord())).collect(Collectors.toList()); // 后续可以继续 往前查找分类
//                } else {
//                    List<Criteria> criteriaList = new ArrayList<>();
//                    for (String code : fourCodeLevelList) {
//                        Criteria criteria = Criteria.where("code").regex("^" + code);
//                        criteriaList.add(criteria);
//                    }
//                    Criteria criteria = new Criteria();
//                    criteria.orOperator(criteriaList.toArray(new Criteria[0]));
//                    criteria.andOperator(Criteria.where("codeLevel").is(4));
//                    List<GradeAndDrugs> fourGradeAndDrugs = MongoUtil.mongo.find(new Query(criteria), GradeAndDrugs.class);
//                    fourGradeAndDrugs.stream().map(item -> fiveNames.addAll(item.getNormalWord())).collect(Collectors.toList());// 后续可以继续 往前查找分类
//                }
//                // 将查询出来的五级中文名字
//                List<String> fiveNames_copy = fiveNames.stream().distinct().collect(Collectors.toList());
//                zhAndEnNames = (List<String>) CollUtil.union(zhAndEnNames, fiveNames_copy);
//            }

            drugNames.addAll(zhAndEnNames);
            drugNames.remove("");
            if (CollUtil.isNotEmpty(drugNames)&&drugNames.size()>1000){
                drugNames = drugNames.subList(0, 1000);
            }
            List<String> zhEnDrugNames = new ArrayList<>();
            if (CollUtil.isNotEmpty(drugNames)) {
                // 目前只要五级中文
                zhEnDrugNames = drugNames.stream().filter(GetSynonymUtil::judgeChinese).distinct().collect(Collectors.toList());
            }
            pageVo.setReferenceDrug(zhEnDrugNames);
            // 这里是页面点击五级中文确认之后的搜索
            List<String> zhAndEnNamesFilter = zhEnDrugNames;
            if (CollUtil.isNotEmpty(referenceDrugDto.getDrugs())) {
                zhAndEnNamesFilter = zhEnDrugNames.stream().filter(str -> {
                    return referenceDrugDto.getDrugs().contains(str);
                }).collect(Collectors.toList());
            }
            // 根据五级中英文去找同类药品不同规格 不同厂家 不同剂型的药
            BoolQueryBuilder boolQueryBuilderOther = QueryBuilders.boolQuery();
            boolQueryBuilderOther.mustNot().add(idsQueryBuilder);
            if (CollUtil.isNotEmpty(zhAndEnNamesFilter)) {
                BoolQueryBuilder inner = QueryBuilders.boolQuery();
                for (String zhAndEnName : zhAndEnNamesFilter) {
                    MultiMatchQueryBuilder multiMatchQueryBuilderByZhAndEnName = QueryBuilders.multiMatchQuery(zhAndEnName, "zhDrugNames", "enDrugNames");
                    multiMatchQueryBuilderByZhAndEnName.operator(Operator.AND);
                    multiMatchQueryBuilderByZhAndEnName.slop(0);
                    multiMatchQueryBuilderByZhAndEnName.type(MultiMatchQueryBuilder.Type.PHRASE);
                    inner.should().add(multiMatchQueryBuilderByZhAndEnName);
                }
                boolQueryBuilderOther.must().add(inner);
            }

            if (StrUtil.isNotBlank(searchWord)) {
                MultiMatchQueryBuilder multiMatchQueryBuilderBysearchWord = QueryBuilders.multiMatchQuery(searchWord, "zhDrugName", "manufacturer", "specifications");
                multiMatchQueryBuilderBysearchWord.operator(Operator.AND);
                multiMatchQueryBuilderBysearchWord.slop(0);
                multiMatchQueryBuilderBysearchWord.type(MultiMatchQueryBuilder.Type.PHRASE);
                boolQueryBuilderOther.must().add(multiMatchQueryBuilderBysearchWord);
            }

            overAll.should().add(boolQueryBuilderOther);
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(overAll);
        nativeSearchQuery.addSort(Sort.by(Sort.Order.desc("_id")));
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(referenceDrugDto.getPageNum() - 1, referenceDrugDto.getPageSize()));
        
        SearchHits<DrugAndIndicationIndex> search = null;
        List<DrugAndPriceVo> list = new ArrayList<>();
        long totalHits = 0;
        try {
            search = RetryUtils.retry(
                    () -> elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class),
                    3,
                    1000,
                    e -> true
            );
        } catch (Exception e) {
            log.error("查询失败", e);
        }       
        if (search != null) {
            totalHits = search.getTotalHits();
            for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
                DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                DrugAndPriceVo drugAndPriceVo = new DrugAndPriceVo();
                DrugInfoNew drugAndIndication = mongoTemplate.findById(content.getId(), DrugInfoNew.class);
                if (drugAndIndication != null) {
                    // List<Criteria> criteriaList = new ArrayList<>();
                    // id
                    drugAndPriceVo.setId(drugAndIndication.getId());
                    // 返回前台的标题 = 药品名称 + 药品厂家
                    StringBuilder title = new StringBuilder();
                    StringBuilder name = new StringBuilder();
                    // 高亮
                    if (StringUtils.isNotBlank(searchWord)) {
                        // 标题
                        String drugName = drugAndIndication.getDrugName();
                        if (StringUtils.isNotBlank(drugName)) {
                            drugName = drugName.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setDrugName(drugName);
                        }
                        // 适应症
                        String indication = drugAndIndication.getIndication();
                        if (StringUtils.isNotBlank(indication)) {
                            indication = indication.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setIndication(indication);
                        }
                        // 商家
                        String manufacturer = drugAndIndication.getManufacturer();
                        if (StringUtils.isNotBlank(manufacturer)) {
                            manufacturer = manufacturer.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setManufacturer(manufacturer);
                        }
                        // 包装规格
                        String specifications = drugAndIndication.getSpecifications();
                        if (StringUtils.isNotBlank(specifications)) {
                            specifications = specifications.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setSpecifications(specifications);
                        }
                    }
                    if (StringUtils.isNotBlank(drugAndIndication.getDrugName())) {
                        title.append(drugAndIndication.getDrugName());
                        name.append(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""));
                    /*Criteria criteria1 = Criteria.where("drugName").is(drugAndIndication.getDrugName());
                    Criteria criteria2 = Criteria.where("productName").is(drugAndIndication.getDrugName());
                    Criteria criteria3 = Criteria.where("commonName").is(drugAndIndication.getDrugName());
                    Criteria criteria = new Criteria();
                    criteria.orOperator(criteria1, criteria2, criteria3);
                    criteriaList.add(criteria);*/
                    }
                    // 规格
                    if (StringUtils.isNotBlank(drugAndIndication.getSpecifications())) {
                        drugAndPriceVo.setSpecifications(drugAndIndication.getSpecifications());
                        name.append("-").append(drugAndIndication.getSpecifications());
                    } else {
                        drugAndPriceVo.setSpecifications("暂无");
                    }
                    if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())) {
                        title.append("-").append(drugAndIndication.getManufacturer());
                        name.append("-").append(drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
                        // criteriaList.add(Criteria.where("manufacturer").is(drugAndIndication.getDrugName()));
                    }
                    drugAndPriceVo.setTitle(title.toString());
                    drugAndPriceVo.setName(name.toString().replaceAll("<span>", "").replaceAll("</span>", ""));
                    // 商品
                    drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameZh()) ? drugAndIndication.getCommunityNameZh() : "");
                    drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameEn()) ? drugAndIndication.getCommunityNameEn() : "");
                    // 转换比
                    drugAndPriceVo.setConversionRate("暂无");
                    // 开始查询药品价格相关数据
                    // 国家医保：甲类，且无支付限制
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndIndication.getMedicalInsurance())) {
                        builder.append("医保");
                        builder.append(drugAndIndication.getMedicalInsurance()).append("类");
                        if (StringUtils.isBlank(drugAndIndication.getPaymentScope())) {
                            builder.append("，且无支付限制");
                        } else {
                            builder.append("，").append(drugAndIndication.getPaymentScope());
                        }
                    }
                    if (StringUtils.isNotBlank(builder.toString())) {
                        drugAndPriceVo.setInsurance(builder.toString());
                    } else {
                        drugAndPriceVo.setInsurance("否");
                    }
                    // 国家基本药物：是
                    StringBuilder essBuider = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndIndication.getEssentialMedicines())) {
                        if ("是".equals(drugAndIndication.getEssentialMedicines())) {
                            essBuider.append(drugAndIndication.getEssentialMedicines());
                            if (StringUtils.isNotBlank(drugAndIndication.getEssentialType())) {
                                essBuider.append("，有△要求");
                            } else {
                                essBuider.append("，无△要求");
                            }
                        } else {
                            essBuider.append("否");
                        }
                    } else {
                        essBuider.append("否");
                    }
                    drugAndPriceVo.setIsEssentialMedicines(essBuider.toString());
                /*Criteria criteria = new Criteria();
                criteria.andOperator(criteriaList.toArray(new Criteria[0]));
                DrugAndPrice drugAndPrice = mongoTemplate.findOne(new Query(criteria), DrugAndPrice.class);
                if (drugAndPrice != null) {
                    //中标价格：XX元
                    String bidWinningPrice = drugAndPrice.getBidWinningPrice();
                    if (StringUtils.isNotBlank(bidWinningPrice)) {
                        drugAndPriceVo.setPrice(bidWinningPrice);
                    }else {
                        drugAndPriceVo.setPrice("暂无");
                    }
                    //国家医保：甲类，且无支付限制
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndPrice.getPaymentType())){
                        builder.append(drugAndPrice.getPaymentType());
                        if (StringUtils.isNotBlank(drugAndPrice.getPaymentScope())){
                            if ("无".equals(drugAndPrice.getPaymentScope())){
                                builder.append("，且无支付限制");
                            }else {
                                builder.append("，").append(drugAndPrice.getPaymentScope());
                            }
                        }
                    }
                    if (StringUtils.isNotBlank(builder.toString())) {
                        drugAndPriceVo.setInsurance(builder.toString());
                    }else {
                        drugAndPriceVo.setInsurance("暂无");
                    }
                    //国家基本药物：是
                    if (StringUtils.isNotBlank(drugAndPrice.getEssentialMedicines())) {
                        drugAndPriceVo.setIsEssentialMedicines(drugAndPrice.getEssentialMedicines());
                    }else {
                        drugAndPriceVo.setIsEssentialMedicines("暂无");
                    }
                }else {
                    drugAndPriceVo.setPrice("暂无");
                    drugAndPriceVo.setInsurance("暂无");
                    drugAndPriceVo.setIsEssentialMedicines("暂无");
                }*/
                    String register = drugAndIndication.getRegister();
                    if (StringUtils.isNotBlank(register)) {
                        DrugInstMini approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInstMini.class);
                        if (ObjectUtil.isNotEmpty(approveCode)) {
                            drugAndPriceVo.setUrl("https://image.evimed.com/pmc/instruction_for_select/" + approveCode.getPdf());
                            drugAndPriceVo.setUrlSuffix(approveCode.getPdf());
                        }
                    } else {
                        drugAndPriceVo.setUrl("");
                    }

//                //开始查询是否有说明书
//                BoolQueryBuilder boolQueryBuilderInstructions = QueryBuilders.boolQuery();
//                //药品名称判定-中文
//                BoolQueryBuilder boolQueryBuilderName = QueryBuilders.boolQuery();
//                MultiMatchQueryBuilder multiMatchQueryBuilderZh = QueryBuilders.multiMatchQuery(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//                multiMatchQueryBuilderZh.operator(Operator.AND);
//                boolQueryBuilderName.should().add(multiMatchQueryBuilderZh);
//                if (StringUtils.isNotBlank(drugAndIndication.getDrugEn())) {
//                    //药品名称判定-英文
//                    MultiMatchQueryBuilder multiMatchQueryBuilderEn = QueryBuilders.multiMatchQuery(drugAndIndication.getDrugEn().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//                    multiMatchQueryBuilderEn.operator(Operator.AND);
//                    boolQueryBuilderName.should().add(multiMatchQueryBuilderEn);
//                }
//                boolQueryBuilderInstructions.must().add(boolQueryBuilderName);
//                if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())) {
//                    //厂家判定
//                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("enterpriseName", drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
//                    matchQueryBuilder.operator(Operator.AND);
//                    boolQueryBuilderInstructions.must().add(matchQueryBuilder);
//                }
//                //只要中文说明书
//
//                NativeSearchQuery nativeSearchQueryInstructions = new NativeSearchQuery(boolQueryBuilderInstructions);
//                nativeSearchQueryInstructions.setPageable(PageRequest.of(0, 1));
//                SearchHits<org.springframework.data.elasticsearch.core.document.Document> searchHits = elasticsearchRestTemplate.search(nativeSearchQueryInstructions, org.springframework.data.elasticsearch.core.document.Document.class, IndexCoordinates.of("instruction_data_index"));
//                List<String> listx = new ArrayList<>(Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药"));
//                for (SearchHit<org.springframework.data.elasticsearch.core.document.Document> searchHit : searchHits) {
//                    org.springframework.data.elasticsearch.core.document.Document contentInstructions = searchHit.getContent();
//                    String pdfName = contentInstructions.getString("pdf_name");
//                    String source = contentInstructions.getString("source");
//                    if (!"nmpa".equals(source)) {
//                        continue;
//                    }
//                    if (listx.contains(source)) {
//                        source = "nmpa";
//                    }
//                    if (StringUtils.isEmpty(pdfName)) {
//                        continue;
//                    }
//                    if (StringUtils.isEmpty(source)) {
//                        continue;
//                    }
//                    String url = "https://image.evimed.com/instructions/" + source + "/" + pdfName;
//                    drugAndPriceVo.setUrl(url);
//                }
                    list.add(drugAndPriceVo);
                }
            }
        }
        pageVo.setTotal(totalHits);
        pageVo.setPages((int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1));
        pageVo.setList(list);
        return pageVo;
    }


    public PageVo<DrugAndPriceVo> drugAndPriceAll(ReferenceDrugAllDto referenceDrugDto) {

        PageVo<DrugAndPriceVo> pageVo = new PageVo<>();
        int pageNum = referenceDrugDto.getPageNum();
        int pageSize = referenceDrugDto.getPageSize();
        BoolQueryBuilder overAll = QueryBuilders.boolQuery();
        overAll.must().add(QueryBuilders.termQuery("drugCategory.keyword", referenceDrugDto.getType()));
        if (StringUtils.isNotBlank(referenceDrugDto.getSearchWord())) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(referenceDrugDto.getSearchWord(), "zhDrugName", "manufacturer", "specifications");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.slop(0);
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            overAll.must().add(multiMatchQueryBuilder);
        }

        if (CollUtil.isNotEmpty(referenceDrugDto.getDrugs())) {
            for (String drug : referenceDrugDto.getDrugs()) {
                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(drug, "zhDrugName");
                multiMatchQueryBuilder.operator(Operator.AND);
                multiMatchQueryBuilder.slop(0);
                multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
                overAll.must().add(multiMatchQueryBuilder);
            }

        }
        String searchWord = referenceDrugDto.getSearchWord();
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(overAll);
        nativeSearchQuery.addSort(Sort.by(Sort.Order.desc("_id")));
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(referenceDrugDto.getPageNum() - 1, referenceDrugDto.getPageSize()));
        SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
        long totalHits = search.getTotalHits();
        pageVo.setTotal(totalHits);
        pageVo.setPages((int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1));
        List<DrugAndPriceVo> list = new ArrayList<>();
        for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
            DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
            DrugAndPriceVo drugAndPriceVo = new DrugAndPriceVo();
            DrugInfoNew drugAndIndication = mongoTemplate.findById(content.getId(), DrugInfoNew.class);
            if (drugAndIndication != null) {
                // List<Criteria> criteriaList = new ArrayList<>();
                // id
                drugAndPriceVo.setId(drugAndIndication.getId());
                // 返回前台的标题 = 药品名称 + 药品厂家
                StringBuilder title = new StringBuilder();
                StringBuilder name = new StringBuilder();
                // 高亮
                if (StringUtils.isNotBlank(searchWord)) {
                    // 标题
                    String drugName = drugAndIndication.getDrugName();
                    if (StringUtils.isNotBlank(drugName)) {
                        drugName = drugName.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setDrugName(drugName);
                    }
                    // 适应症
                    String indication = drugAndIndication.getIndication();
                    if (StringUtils.isNotBlank(indication)) {
                        indication = indication.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setIndication(indication);
                    }
                    // 商家
                    String manufacturer = drugAndIndication.getManufacturer();
                    if (StringUtils.isNotBlank(manufacturer)) {
                        manufacturer = manufacturer.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setManufacturer(manufacturer);
                    }
                    // 包装规格
                    String specifications = drugAndIndication.getSpecifications();
                    if (StringUtils.isNotBlank(specifications)) {
                        specifications = specifications.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                        drugAndIndication.setSpecifications(specifications);
                    }
                }
                if (StringUtils.isNotBlank(drugAndIndication.getDrugName())) {
                    title.append(drugAndIndication.getDrugName());
                    name.append(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""));
                    /*Criteria criteria1 = Criteria.where("drugName").is(drugAndIndication.getDrugName());
                    Criteria criteria2 = Criteria.where("productName").is(drugAndIndication.getDrugName());
                    Criteria criteria3 = Criteria.where("commonName").is(drugAndIndication.getDrugName());
                    Criteria criteria = new Criteria();
                    criteria.orOperator(criteria1, criteria2, criteria3);
                    criteriaList.add(criteria);*/
                }
                // 规格
                if (StringUtils.isNotBlank(drugAndIndication.getSpecifications())) {
                    drugAndPriceVo.setSpecifications(drugAndIndication.getSpecifications());
                    name.append("-").append(drugAndIndication.getSpecifications());
                } else {
                    drugAndPriceVo.setSpecifications("暂无");
                }
                if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())) {
                    title.append("-").append(drugAndIndication.getManufacturer());
                    name.append("-").append(drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
                    // criteriaList.add(Criteria.where("manufacturer").is(drugAndIndication.getDrugName()));
                }
                drugAndPriceVo.setTitle(title.toString());
                drugAndPriceVo.setName(name.toString().replaceAll("<span>", "").replaceAll("</span>", ""));
                // 商品
                drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameZh()) ? drugAndIndication.getCommunityNameZh() : "");
                drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameEn()) ? drugAndIndication.getCommunityNameEn() : "");
                // 转换比
                drugAndPriceVo.setConversionRate("暂无");
                // 开始查询药品价格相关数据
                // 国家医保：甲类，且无支付限制
                StringBuilder builder = new StringBuilder();
                if (StringUtils.isNotBlank(drugAndIndication.getMedicalInsurance())) {
                    builder.append("医保");
                    builder.append(drugAndIndication.getMedicalInsurance()).append("类");
                    if (StringUtils.isBlank(drugAndIndication.getPaymentScope())) {
                        builder.append("，且无支付限制");
                    } else {
                        builder.append("，").append(drugAndIndication.getPaymentScope());
                    }
                }
                if (StringUtils.isNotBlank(builder.toString())) {
                    drugAndPriceVo.setInsurance(builder.toString());
                } else {
                    drugAndPriceVo.setInsurance("否");
                }
                // 国家基本药物：是
                StringBuilder essBuider = new StringBuilder();
                if (StringUtils.isNotBlank(drugAndIndication.getEssentialMedicines())) {
                    if ("是".equals(drugAndIndication.getEssentialMedicines())) {
                        essBuider.append(drugAndIndication.getEssentialMedicines());
                        if (StringUtils.isNotBlank(drugAndIndication.getEssentialType())) {
                            essBuider.append("，有△要求");
                        } else {
                            essBuider.append("，无△要求");
                        }
                    } else {
                        essBuider.append("否");
                    }
                } else {
                    essBuider.append("否");
                }
                drugAndPriceVo.setIsEssentialMedicines(essBuider.toString());
                /*Criteria criteria = new Criteria();
                criteria.andOperator(criteriaList.toArray(new Criteria[0]));
                DrugAndPrice drugAndPrice = mongoTemplate.findOne(new Query(criteria), DrugAndPrice.class);
                if (drugAndPrice != null) {
                    //中标价格：XX元
                    String bidWinningPrice = drugAndPrice.getBidWinningPrice();
                    if (StringUtils.isNotBlank(bidWinningPrice)) {
                        drugAndPriceVo.setPrice(bidWinningPrice);
                    }else {
                        drugAndPriceVo.setPrice("暂无");
                    }
                    //国家医保：甲类，且无支付限制
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndPrice.getPaymentType())){
                        builder.append(drugAndPrice.getPaymentType());
                        if (StringUtils.isNotBlank(drugAndPrice.getPaymentScope())){
                            if ("无".equals(drugAndPrice.getPaymentScope())){
                                builder.append("，且无支付限制");
                            }else {
                                builder.append("，").append(drugAndPrice.getPaymentScope());
                            }
                        }
                    }
                    if (StringUtils.isNotBlank(builder.toString())) {
                        drugAndPriceVo.setInsurance(builder.toString());
                    }else {
                        drugAndPriceVo.setInsurance("暂无");
                    }
                    //国家基本药物：是
                    if (StringUtils.isNotBlank(drugAndPrice.getEssentialMedicines())) {
                        drugAndPriceVo.setIsEssentialMedicines(drugAndPrice.getEssentialMedicines());
                    }else {
                        drugAndPriceVo.setIsEssentialMedicines("暂无");
                    }
                }else {
                    drugAndPriceVo.setPrice("暂无");
                    drugAndPriceVo.setInsurance("暂无");
                    drugAndPriceVo.setIsEssentialMedicines("暂无");
                }*/
                String register = drugAndIndication.getRegister();
                if (StringUtils.isNotBlank(register)) {
                    DrugInstMini approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInstMini.class);
                    if (ObjectUtil.isNotEmpty(approveCode)) {
                        drugAndPriceVo.setUrl("https://image.evimed.com/pmc/instruction_for_select/" + approveCode.getPdf());
                        drugAndPriceVo.setUrlSuffix(approveCode.getPdf());
                    }
                } else {
                    drugAndPriceVo.setUrl("");
                }

//                //开始查询是否有说明书
//                BoolQueryBuilder boolQueryBuilderInstructions = QueryBuilders.boolQuery();
//                //药品名称判定-中文
//                BoolQueryBuilder boolQueryBuilderName = QueryBuilders.boolQuery();
//                MultiMatchQueryBuilder multiMatchQueryBuilderZh = QueryBuilders.multiMatchQuery(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//                multiMatchQueryBuilderZh.operator(Operator.AND);
//                boolQueryBuilderName.should().add(multiMatchQueryBuilderZh);
//                if (StringUtils.isNotBlank(drugAndIndication.getDrugEn())) {
//                    //药品名称判定-英文
//                    MultiMatchQueryBuilder multiMatchQueryBuilderEn = QueryBuilders.multiMatchQuery(drugAndIndication.getDrugEn().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//                    multiMatchQueryBuilderEn.operator(Operator.AND);
//                    boolQueryBuilderName.should().add(multiMatchQueryBuilderEn);
//                }
//                boolQueryBuilderInstructions.must().add(boolQueryBuilderName);
//                if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())) {
//                    //厂家判定
//                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("enterpriseName", drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
//                    matchQueryBuilder.operator(Operator.AND);
//                    boolQueryBuilderInstructions.must().add(matchQueryBuilder);
//                }
//                //只要中文说明书
//
//                NativeSearchQuery nativeSearchQueryInstructions = new NativeSearchQuery(boolQueryBuilderInstructions);
//                nativeSearchQueryInstructions.setPageable(PageRequest.of(0, 1));
//                SearchHits<org.springframework.data.elasticsearch.core.document.Document> searchHits = elasticsearchRestTemplate.search(nativeSearchQueryInstructions, org.springframework.data.elasticsearch.core.document.Document.class, IndexCoordinates.of("instruction_data_index"));
//                List<String> listx = new ArrayList<>(Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药"));
//                for (SearchHit<org.springframework.data.elasticsearch.core.document.Document> searchHit : searchHits) {
//                    org.springframework.data.elasticsearch.core.document.Document contentInstructions = searchHit.getContent();
//                    String pdfName = contentInstructions.getString("pdf_name");
//                    String source = contentInstructions.getString("source");
//                    if (!"nmpa".equals(source)) {
//                        continue;
//                    }
//                    if (listx.contains(source)) {
//                        source = "nmpa";
//                    }
//                    if (StringUtils.isEmpty(pdfName)) {
//                        continue;
//                    }
//                    if (StringUtils.isEmpty(source)) {
//                        continue;
//                    }
//                    String url = "https://image.evimed.com/instructions/" + source + "/" + pdfName;
//                    drugAndPriceVo.setUrl(url);
//                }
                list.add(drugAndPriceVo);
            }
        }
        // 生成缓存键，基于查询条件生成唯一标识符
        String cacheKey = "drugZhAgg:" + referenceDrugDto.getType();
// 尝试从缓存中获取数据
        Object cachedResult = redisTemplate.opsForValue().get(cacheKey);
        if (cachedResult != null) {
            @SuppressWarnings("unchecked")
            List<String> drugZhList = (List<String>) cachedResult;
            pageVo.setDrugs(drugZhList); // 使用缓存结果
        } else {
            NativeSearchQuery aggregationQuery = new NativeSearchQuery(overAll);
            aggregationQuery.addAggregation(AggregationBuilders.terms("drugZhAgg").field("drugZh.keyword").size(100000));
            SearchHits<DrugAndIndicationIndex> aggregationSearch = elasticsearchRestTemplate.search(aggregationQuery, DrugAndIndicationIndex.class);
            Aggregations aggregations = aggregationSearch.getAggregations();

            List<String> drugZhList = new ArrayList<>();
            if (aggregations != null) {
                Aggregation drugZhAggregation = aggregations.get("drugZhAgg");
                List<? extends Terms.Bucket> buckets = ((ParsedTerms) drugZhAggregation).getBuckets();
                for (Terms.Bucket bucket : buckets) {
                    String drugZh = bucket.getKey().toString();
                    drugZhList.add(drugZh);
                }
            }

            // 将结果存储到缓存中，设置过期时间为 1 小时
            redisTemplate.opsForValue().set(cacheKey, drugZhList, 1, TimeUnit.HOURS);
            pageVo.setDrugs(drugZhList); // 使用聚合结果
        }

        pageVo.setList(list);
        return pageVo;
    }


    /**
     * 如果是中成药   则使用这个逻辑
     */
    public PageVo<DrugAndPriceVo> drugAndPriceTr(ReferenceDrugDto referenceDrugDto) {
        PageVo<DrugAndPriceVo> pageVo = new PageVo<>();
        Integer pageNum = referenceDrugDto.getPageNum();
        pageVo.setPageNum(pageNum);
        Integer pageSize = referenceDrugDto.getPageSize();
        pageVo.setPageSize(pageSize);

        DrugInfoNew byId = mongoTemplate.findById(referenceDrugDto.getDrugId(), DrugInfoNew.class);
        // 大的查询bool
        BoolQueryBuilder overAll = QueryBuilders.boolQuery();

        // 开始根据疾病查询药品适应症表
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        String drugId = referenceDrugDto.getDrugId();
        IdsQueryBuilder idsQueryBuilder = QueryBuilders.idsQuery().addIds(drugId);
        boolQueryBuilder.mustNot().add(idsQueryBuilder);

        TermQueryBuilder termQuery = QueryBuilders.termQuery("disease.keyword", referenceDrugDto.getDisease());
        // 开始统计全部药品名称
        List<String> drugNames = new ArrayList<>();
        NativeSearchQuery statisticsQuery = new NativeSearchQuery(termQuery);
        // 五级中文
        statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugNames.keyword").size(30));
        SearchHits<DrugAndIndicationIndex> indexSearchHits = elasticsearchRestTemplate.search(statisticsQuery, DrugAndIndicationIndex.class);
        Aggregations aggregations = indexSearchHits.getAggregations();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("zhDrugName");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                String string = bucket.getKey().toString();
                drugNames.add(string);
            }
        } else {
            statisticsQuery = new NativeSearchQuery(termQuery);
            // 五级英文
            statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("enDrugNames.keyword").size(30));
            indexSearchHits = elasticsearchRestTemplate.search(statisticsQuery, DrugAndIndicationIndex.class);
            aggregations = indexSearchHits.getAggregations();
            if (aggregations != null) {
                Aggregation aggregation = aggregations.get("zhDrugName");
                List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                for (Terms.Bucket bucket : buckets) {
                    String string = bucket.getKey().toString();
                    drugNames.add(string);
                }
            } else {
                statisticsQuery = new NativeSearchQuery(termQuery);
                // 产品名称
                statisticsQuery.addAggregation(AggregationBuilders.terms("zhDrugName").field("zhDrugName.keyword").size(30));
                indexSearchHits = elasticsearchRestTemplate.search(statisticsQuery, DrugAndIndicationIndex.class);
                aggregations = indexSearchHits.getAggregations();
                if (aggregations != null) {
                    Aggregation aggregation = aggregations.get("zhDrugName");
                    List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                    for (Terms.Bucket bucket : buckets) {
                        String string = bucket.getKey().toString();
                        drugNames.add(string);
                    }
                }
            }
        }
        pageVo.setReferenceDrug(drugNames);
        // 1.查找治疗指定病的药
        boolQueryBuilder.must().add(termQuery);

        // 用户勾选了页面参比药物分类
        if (CollUtil.isNotEmpty(referenceDrugDto.getDrugs())) {
            BoolQueryBuilder inner = QueryBuilders.boolQuery();
            List<String> drugList = referenceDrugDto.getDrugs();
            for (String s : drugList) {
                MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("drugName", s);
                matchQueryBuilder.operator(Operator.AND);
                inner.should().add(matchQueryBuilder);
            }
            boolQueryBuilder.must().add(inner);
        }

        // 拼接用户单独检索条件
        String searchWord = referenceDrugDto.getSearchWord();
        if (StringUtils.isNotBlank(searchWord)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchWord, "zhDrugName", "manufacturer", "specifications");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.slop(0);
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            boolQueryBuilder.must().add(multiMatchQueryBuilder);
        }

        overAll.should().add(boolQueryBuilder);

        // 2. 查询 同药品 不同规格不同剂型、不同厂家的药品需要作为其参比药品
        NativeSearchQuery idNativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
        idNativeSearchQuery.setTrackTotalHits(true);
        SearchHits<DrugAndIndicationIndex> drugAndIndicationIndex = elasticsearchRestTemplate.search(idNativeSearchQuery, DrugAndIndicationIndex.class);
        if (drugAndIndicationIndex.getTotalHits() > 0) {
            List<String> zhDrugNames = new ArrayList<>();
            List<String> zhAndEnNames = zhDrugNames;
            ArrayList<String> names = new ArrayList<>();
            List<JSONObject> jsonObjects = mongoTemplate.find(Query.query(Criteria.where("name").is(byId.getDrugName())), JSONObject.class, "drug_category_tr");
            if (jsonObjects.size() > 0) {
                List<Criteria> orConditions = new ArrayList<>();
                jsonObjects.forEach(jsonObject -> {
                    List<Criteria> andConditions = new ArrayList<>();
                    if (StringUtils.isNotEmpty(jsonObject.getString("level1"))) {
                        andConditions.add(Criteria.where("level1").is(jsonObject.getString("level1")));
                    } else {
                        andConditions.add(Criteria.where("level1").is(null));
                    }

                    if (StringUtils.isNotEmpty(jsonObject.getString("level2"))) {
                        andConditions.add(Criteria.where("level2").is(jsonObject.getString("level2")));
                    } else {
                        andConditions.add(Criteria.where("level2").is(null));
                    }

                    if (StringUtils.isNotEmpty(jsonObject.getString("level3"))) {
                        andConditions.add(Criteria.where("level3").is(jsonObject.getString("level3")));
                    } else {
                        andConditions.add(Criteria.where("level3").is(null));
                    }

                    if (StringUtils.isNotEmpty(jsonObject.getString("level4"))) {
                        andConditions.add(Criteria.where("level4").is(jsonObject.getString("level4")));
                    } else {
                        andConditions.add(Criteria.where("level4").is(null));
                    }

                    Criteria criteriaAnd = new Criteria();
                    if (!andConditions.isEmpty()) {
                        criteriaAnd.andOperator(andConditions.toArray(new Criteria[0]));
                    }

                    orConditions.add(criteriaAnd);

                });
                Criteria finalCriteria = new Criteria();
                if (!orConditions.isEmpty()) {
                    finalCriteria.orOperator(orConditions.toArray(new Criteria[0]));
                }
                List<JSONObject> categoryTr = mongoTemplate.find(Query.query(finalCriteria), JSONObject.class, "drug_category_tr");
                categoryTr.forEach(jsonObject -> {
                    String string = jsonObject.getString("name");
                    names.add(string);
                });
            }
            List<DrugInfoNew> drugInfo = mongoTemplate.find(Query.query(Criteria.where("drugName").is(byId.getDrugName())), DrugInfoNew.class);
            if (drugInfo.size() == 1) {
                names.removeIf(name -> name.equals(byId.getDrugName()));
            } else if (CollUtil.isEmpty(names) && drugInfo.size() > 1) {
                names.add(byId.getDrugName());
            }
            names.removeIf(name -> name.equals(""));
            zhAndEnNames = (ArrayList<String>) CollUtil.union(zhAndEnNames, names);


            drugNames.addAll(zhAndEnNames);
            drugNames.remove("");
            List<String> zhEnDrugNames = new ArrayList<>();
            if (CollUtil.isNotEmpty(drugNames)) {
                // 目前只要五级中文
                zhEnDrugNames = drugNames.stream().filter(GetSynonymUtil::judgeChinese).distinct().collect(Collectors.toList());
            }
            pageVo.setReferenceDrug(zhEnDrugNames);
            // 这里是页面点击五级中文确认之后的搜索
            List<String> zhAndEnNamesFilter = zhEnDrugNames;
            if (CollUtil.isNotEmpty(referenceDrugDto.getDrugs())) {
                zhAndEnNamesFilter = zhEnDrugNames.stream().filter(str -> {
                    return referenceDrugDto.getDrugs().contains(str);
                }).collect(Collectors.toList());
            }
            if (CollUtil.isNotEmpty(zhAndEnNamesFilter)) {

                // 根据五级中英文去找同类药品不同规格 不同厂家 不同剂型的药
                BoolQueryBuilder boolQueryBuilderOther = QueryBuilders.boolQuery();
                boolQueryBuilderOther.mustNot().add(idsQueryBuilder);
                if (CollUtil.isNotEmpty(zhAndEnNamesFilter)) {
                    BoolQueryBuilder inner = QueryBuilders.boolQuery();
                    for (String zhAndEnName : zhAndEnNamesFilter) {
                        MultiMatchQueryBuilder multiMatchQueryBuilderByZhAndEnName = QueryBuilders.multiMatchQuery(zhAndEnName, "zhDrugName");
                        multiMatchQueryBuilderByZhAndEnName.operator(Operator.AND);
                        multiMatchQueryBuilderByZhAndEnName.slop(0);
                        multiMatchQueryBuilderByZhAndEnName.type(MultiMatchQueryBuilder.Type.PHRASE);
                        inner.should().add(multiMatchQueryBuilderByZhAndEnName);
                    }
                    boolQueryBuilderOther.must().add(inner);
                }

                if (StrUtil.isNotBlank(searchWord)) {
                    MultiMatchQueryBuilder multiMatchQueryBuilderBysearchWord = QueryBuilders.multiMatchQuery(searchWord, "zhDrugName", "manufacturer", "specifications");
                    multiMatchQueryBuilderBysearchWord.operator(Operator.AND);
                    multiMatchQueryBuilderBysearchWord.slop(0);
                    multiMatchQueryBuilderBysearchWord.type(MultiMatchQueryBuilder.Type.PHRASE);
                    boolQueryBuilderOther.must().add(multiMatchQueryBuilderBysearchWord);
                }

                overAll.should().add(boolQueryBuilderOther);
            }
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(overAll);
            nativeSearchQuery.addSort(Sort.by(Sort.Order.desc("_id")));
            nativeSearchQuery.setTrackTotalHits(true);
            nativeSearchQuery.setPageable(PageRequest.of(referenceDrugDto.getPageNum() - 1, referenceDrugDto.getPageSize()));
            SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
            long totalHits = search.getTotalHits();
            pageVo.setTotal(totalHits);
            pageVo.setPages((int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1));
            List<DrugAndPriceVo> list = new ArrayList<>();
            for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
                DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                DrugAndPriceVo drugAndPriceVo = new DrugAndPriceVo();
                DrugInfoNew drugAndIndication = mongoTemplate.findById(content.getId(), DrugInfoNew.class);
                if (drugAndIndication != null) {
                    // List<Criteria> criteriaList = new ArrayList<>();
                    // id
                    drugAndPriceVo.setId(drugAndIndication.getId());
                    // 返回前台的标题 = 药品名称 + 药品厂家
                    StringBuilder title = new StringBuilder();
                    StringBuilder name = new StringBuilder();
                    // 高亮
                    if (StringUtils.isNotBlank(searchWord)) {
                        // 标题
                        String drugName = drugAndIndication.getDrugName();
                        if (StringUtils.isNotBlank(drugName)) {
                            drugName = drugName.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setDrugName(drugName);
                        }
                        // 适应症
                        String indication = drugAndIndication.getIndication();
                        if (StringUtils.isNotBlank(indication)) {
                            indication = indication.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setIndication(indication);
                        }
                        // 商家
                        String manufacturer = drugAndIndication.getManufacturer();
                        if (StringUtils.isNotBlank(manufacturer)) {
                            manufacturer = manufacturer.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setManufacturer(manufacturer);
                        }
                        // 包装规格
                        String specifications = drugAndIndication.getSpecifications();
                        if (StringUtils.isNotBlank(specifications)) {
                            specifications = specifications.replaceAll("(?i)" + searchWord, "<span>" + searchWord + "</span>");
                            drugAndIndication.setSpecifications(specifications);
                        }
                    }
                    if (StringUtils.isNotBlank(drugAndIndication.getDrugName())) {
                        title.append(drugAndIndication.getDrugName());
                        name.append(drugAndIndication.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""));

                    }
                    // 规格
                    if (StringUtils.isNotBlank(drugAndIndication.getSpecifications())) {
                        drugAndPriceVo.setSpecifications(drugAndIndication.getSpecifications());
                        name.append("-").append(drugAndIndication.getSpecifications());
                    } else {
                        drugAndPriceVo.setSpecifications("暂无");
                    }
                    if (StringUtils.isNotBlank(drugAndIndication.getManufacturer())) {
                        title.append("-").append(drugAndIndication.getManufacturer());
                        name.append("-").append(drugAndIndication.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
                        // criteriaList.add(Criteria.where("manufacturer").is(drugAndIndication.getDrugName()));
                    }
                    drugAndPriceVo.setTitle(title.toString());
                    drugAndPriceVo.setName(name.toString().replaceAll("<span>", "").replaceAll("</span>", ""));
                    // 商品
                    drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameZh()) ? drugAndIndication.getCommunityNameZh() : "");
                    drugAndPriceVo.setCommunityNameZh(StrUtil.isNotBlank(drugAndIndication.getCommunityNameEn()) ? drugAndIndication.getCommunityNameEn() : "");
                    // 转换比
                    drugAndPriceVo.setConversionRate("暂无");
                    // 开始查询药品价格相关数据
                    // 国家医保：甲类，且无支付限制
                    StringBuilder builder = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndIndication.getMedicalInsurance())) {
                        builder.append("医保");
                        builder.append(drugAndIndication.getMedicalInsurance()).append("类");
                        if (StringUtils.isBlank(drugAndIndication.getPaymentScope())) {
                            builder.append("，且无支付限制");
                        } else {
                            builder.append("，").append(drugAndIndication.getPaymentScope());
                        }
                    }
                    if (StringUtils.isNotBlank(builder.toString())) {
                        drugAndPriceVo.setInsurance(builder.toString());
                    } else {
                        drugAndPriceVo.setInsurance("否");
                    }
                    // 国家基本药物：是
                    StringBuilder essBuider = new StringBuilder();
                    if (StringUtils.isNotBlank(drugAndIndication.getEssentialMedicines())) {
                        if ("是".equals(drugAndIndication.getEssentialMedicines())) {
                            essBuider.append(drugAndIndication.getEssentialMedicines());
                            if (StringUtils.isNotBlank(drugAndIndication.getEssentialType())) {
                                essBuider.append("，有△要求");
                            } else {
                                essBuider.append("，无△要求");
                            }
                        } else {
                            essBuider.append("否");
                        }
                    } else {
                        essBuider.append("否");
                    }
                    drugAndPriceVo.setIsEssentialMedicines(essBuider.toString());

                    String register = drugAndIndication.getRegister();
                    if (StringUtils.isNotBlank(register)) {
                        DrugInstMini approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInstMini.class);
                        if (ObjectUtil.isNotEmpty(approveCode)) {
                            drugAndPriceVo.setUrl("https://image.evimed.com/pmc/instruction_for_select/" + approveCode.getPdf());
                            drugAndPriceVo.setUrlSuffix(approveCode.getPdf());
                        }
                    } else {
                        drugAndPriceVo.setUrl("");
                    }


                    list.add(drugAndPriceVo);
                }
            }
            pageVo.setList(list);
        }
        return pageVo;
    }

    @Override
    public String saveDrugPrice(SaveDrugPriceDto saveDrugPriceDto) {
        List<SaveDrugPrice> list = saveDrugPriceDto.getList();
        String priceId = UUID.randomUUID().toString();
        for (SaveDrugPrice saveDrugPrice : list) {
            saveDrugPrice.setId(UUID.randomUUID().toString());
            saveDrugPrice.setPriceId(priceId);
        }
        try {
            mongoTemplate.insert(list, SaveDrugPrice.class);
            return priceId;
        } catch (Exception e) {
            e.printStackTrace();
            return "-1";
        }
    }

    @Override
    public JSONObject suOnline(String id) {
        JSONObject drugAnalyzeData = mongoTemplate.findOne(new Query(Criteria.where("id").is(id)), JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData != null) {
            String string = drugAnalyzeData.getJSONObject("safety").getJSONObject("details").getString("pharmacovigilance");
            String[] split = string.split("\n");
            drugAnalyzeData.getJSONObject("safety").getJSONObject("details").put("pharmacovigilance", split);
            return drugAnalyzeData;
        }
        return new JSONObject();
    }

    @Override
    public JSONObject guideOnline(String id) {
        JSONObject drugAnalyzeData = mongoTemplate.findOne(new Query(Criteria.where("id").is(id)), JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData != null) {
            return drugAnalyzeData;
        }
        return new JSONObject();
//        JSONObject result = new JSONObject();
//        //报告标题
//        result.put("title", "“阿司匹林肠溶片”临床综合评价报告");
//        //报告时间
//        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd");
//        result.put("time", format.format(new Date()));
//        //第一部分 总体概括 overallSummary
//        JSONObject overallSummary = new JSONObject();
//        //目标药物
//        overallSummary.put("targetDrug", "阿司匹林肠溶片");
//        //综合得分
//        overallSummary.put("comprehensiveScore", "65");
//        //建议
//        overallSummary.put("recommendation", "临床上治疗XX疾病时，强推荐使用XX。");
//        //药品综合评价维度图
//        JSONArray dimensionDiagram = new JSONArray();
//        JSONObject json1 = new JSONObject();
//        json1.put("name", "安全性");
//        json1.put("value", "34");
//        json1.put("max", guideMaxMap.get("安全性"));
//        dimensionDiagram.add(json1);
//        JSONObject json2 = new JSONObject();
//        json2.put("name", "有效性");
//        json2.put("value", "48");
//        json2.put("max", guideMaxMap.get("有效性"));
//        dimensionDiagram.add(json2);
//        JSONObject json3 = new JSONObject();
//        json3.put("name", "经济性");
//        json3.put("value", "18");
//        json3.put("max", guideMaxMap.get("经济性"));
//        dimensionDiagram.add(json3);
//        JSONObject json4 = new JSONObject();
//        json4.put("name", "其他属性");
//        json4.put("value", "5");
//        json4.put("max", guideMaxMap.get("其他属性"));
//        dimensionDiagram.add(json4);
//        JSONObject json5 = new JSONObject();
//        json5.put("name", "药学特性");
//        json5.put("value", "5");
//        json5.put("max", guideMaxMap.get("药学特性"));
//        dimensionDiagram.add(json5);
//        overallSummary.put("dimensionDiagram", dimensionDiagram);
//        result.put("overallSummary", overallSummary);
//        //第二部分 药品综合评价之药学特性
//        JSONObject pharmaceuticalCharacteristics = new JSONObject();
//        //药学特性得分
//        pharmaceuticalCharacteristics.put("score", "注射用卡非佐米在药学特性上的得分为：18 分");
//        //药学特性综述
//        pharmaceuticalCharacteristics.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，针对注射用卡非佐米的药学特性进行评价：总分28分，主要从药理作用（5分）、体内过程（5分）、药剂学与使用方法（12分）、贮藏条件（4分）以及药品有效期（2分）五方面考察药品的药学特性。");
//        //根据灵犀数据库资料分析
//        List<String> characterTitle = Arrays.asList("序号", "评价条目", "相关内容", "得分");
//        List<String> character1 = Arrays.asList("1", "药理作用", "卡非佐米为四肽环氧酮结构的蛋白酶体抑制剂，能够不可逆地结合20S蛋白酶体(即26S蛋白酶体蛋白水解核心颗粒)的N-末端含苏氨酸活性位点。卡非佐米对实体瘤和血液肿瘤细胞具有体外抗增殖和促凋亡活性。在动物试验中，卡非佐米可在血液和组织中抑制蛋白酶体活性，并在多发性骨髓瘤、血液学和实体瘤模型中延缓肿瘤生长。", "4分");
//        List<String> character2 = Arrays.asList("2", "体内过程", "分布<br/>给子20mg/m²非佐米后，平均稳态分布容积为28L。体外试验中，在0.4到4微摩尔的浓度范围内，卡非佐米与人血浆蛋百结合率为97%。<br/>消除<br/>在第1周期第1天经静脉给予≥15mg/m²的剂量后，卡非佐米的半衰期≤1小时。输注时间为30分种与2至10分钟时的半衰期相似。全身清除率为151至263L/小时。<br/>代谢<br/>卡非佐米通过肽酶裂解和环氧化物水解被快速代谢，其为卡非佐米的主要代谢途径，细胞色素P450(CYP)介导的机制在卡非佐米的整体代谢中发挥很小的作用。<br/>排泄<br/>大约25%的卡非佐米给药剂量在24小时内以代谢物形式在尿中排泄。原形化合物通过尿和粪便排泄的量可忽略不计(占总剂量的0.3%)。", "3分");
//        List<String> character3 = Arrays.asList("3", "药剂学与使用方法", "卡非佐米可通过50mL或100mL输液袋装的5%葡萄糖注射液进行静脉给药。输液持续时间30分钟以上。应通过静脉输液方式进行给药。在卡非佐米给药前后即刻用生理盐水或5%葡萄糖注射液冲洗输注管。", "9分");
//        List<String> character4 = Arrays.asList("4", "贮藏条件", "避光，密闭，2℃～8℃保存。在原包装中保存。", "1分");
//        List<String> character5 = Arrays.asList("5", "药品有效期", "36个月", "1分");
//        List<List<String>> characterTable = Arrays.asList(characterTitle, character1, character2, character3, character4, character5);
//        pharmaceuticalCharacteristics.put("table", characterTable);
//        result.put("pharmaceuticalCharacteristics", pharmaceuticalCharacteristics);
//        //第三部分 药品综合评价之有效性
//        JSONObject effectiveness = new JSONObject();
//        //有效性得分
//        effectiveness.put("score", "阿司匹林肠溶片在有效性上的得分为：XX 分");
//        //综述
//        effectiveness.put("summarize", "总分24分，主要从证据推荐情况（22分）、与同类药品相比，临床治疗有特别优势（2分）两方面考察药品的有效性。");
//        //指南/共识等推荐详情
//        List<List<String>> lists = new ArrayList<>();
//        List<String> listTitle = Arrays.asList("指南名称", "发布机构", "发布日期", "推荐等级", "相关内容");
//        lists.add(listTitle);
//        List<String> list = Arrays.asList("标题", "发布机构名称", "时间/日期", "强推荐", "对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。");
//        for (int i = 0; i < 5; i++) {
//            lists.add(list);
//        }
//        effectiveness.put("table", lists);
//        //适应证
//        effectiveness.put("indication", "怡可安（卡格列净）在心衰治疗中可以作为临床必需或首选药物之一，但具体的治疗方案应根据患者的个体情况、心衰的类型和分级、合并疾病等因素来决定。此外，除怡可安之外，还存在其他替代药物可用于心衰治疗。");
//        //临床疗效
//        effectiveness.put("effectiveness", "在怡可安（卡格列净）治疗心衰的临床研究中，主要疗效终点指标通常被用于评估其疗效。这些主要疗效终点指标可能包括心衰加重、心衰住院风险、生活质量改善以及心血管事件的发生率等。这些指标对于评估怡可安在心衰患者中的治疗效果具有重要意义。");
//        result.put("effectiveness", effectiveness);
//        //第四部分 药品综合评价之安全性
//        JSONObject safety = new JSONObject();
//        //安全性得分
//        safety.put("score", "阿司匹林肠溶片在安全性上的得分为：XX 分");
//        //综述
//        safety.put("summarize", "总分17分，主要从不良反应的严重程度及发生率（8分）、与同类药品相比安全性优势（2分）、特殊人群用药情况（5分）以及药物警戒情况（42分）四方面考察药品的安全性");
//        //根据灵犀数据库资料分析 表格
//        List<String> safetyTitle = Arrays.asList("序号", "评价条目", "相关内容", "得分");
//        List<String> safety1 = Arrays.asList("1", "中度不良反应", "算法提供（说明书中没有相应数据时，需要算法从其他途径获取）", "3分");
//        List<String> safety2 = Arrays.asList("2", "重度不良反应", "心力衰竭、心肌梗死、心脏骤停、心肌缺血、间质性肺病、肺炎、急性呼吸窘迫综合征、急性呼吸衰竭、肺动脉高压、呼吸困难、高血压(包括高血压危象)、急性肾损伤、肿瘤溶解综合征、输注相关反应、胃肠道出血、颅内出血、肺出血、血小板减少症、肝衰竭、乙型肝炎病毒再激活、可逆性后部脑病综合征(PRES)、血栓性微血管病和血栓性血小板减少性紫癜/溶血尿毒综合征(TTP/HUS)。", "1分");
//        List<String> safety3 = Arrays.asList("3", "特殊人群", "需算法通过说明书中内容，分别总结以下特殊人群是否可用（儿童还需精确到年龄范围）。<br/>儿童：<br/>老人：<br/>妊娠期妇女：<br/>哺乳期妇女：<br/>肝功能异常：<br/>肾功能异常：", "1分");
//        List<String> safety4 = Arrays.asList("4", "相互作用", "算法总结并输出", "1分");
//        List<String> safety5 = Arrays.asList("5", "其他", "算法总结待评价药品不良反应是否可逆，有无致畸性和致癌性，以及是否有特别用药警示（或黑框警告）", "1分");
//        List<List<String>> safetyTable = Arrays.asList(safetyTitle, safety1, safety2, safety3, safety4, safety5);
//        safety.put("table", safetyTable);
//        result.put("safety", safety);
//        //第五部分 药品综合评价之经济性
//        JSONObject economical = new JSONObject();
//        //经济性得分
//        economical.put("score", "注射用卡非佐米在经济性上的得分为： 4.5 分");
//        //综述
//        economical.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，针对注射用卡非佐米的经济性进行评价：总分10分，考察药品与同通用名药物（3分）及主要适应证可替代药品（7分）的日均治疗费用差异。");
//        List<String> economicalTitle = Arrays.asList("序号", "药品名称", "规格", "转换比", "生产企业", "中标价");
//        List<String> economical1 = Arrays.asList("序号1", "药品名称1", "规格1", "转换比1", "生产企业1", "中标价1");
//        List<String> economical2 = Arrays.asList("序号2", "药品名称2", "规格2", "转换比2", "生产企业2", "中标价2");
//        //根据灵犀数据库资料：认为XX更具有经济性。
//        economical.put("mostEconomical", "XX");
//        //同通用名药品
//        JSONObject genericDrugs = new JSONObject();
//        genericDrugs.put("title", "查找到与待评价药品为同通用名的药品共有XX个（详情见下表）。系统通过AI计算，同通用名的药品中最低日均治疗费用为 XX 元。");
//        List<List<String>> genericDrugsList = Arrays.asList(economicalTitle, economical1, economical2);
//        genericDrugs.put("table", genericDrugsList);
//        economical.put("genericDrugs", genericDrugs);
//        //替代药品
//        JSONObject alternativeMedicines = new JSONObject();
//        alternativeMedicines.put("title", "查找到与待评价药品主要适应证的替代药品，或与其为同类或通作用机制的药品共有XX个。");
//        alternativeMedicines.put("table", genericDrugsList);
//        economical.put("alternativeMedicines", alternativeMedicines);
//        result.put("economical", economical);
//        //第六部分 药品综合评价之其他属性
//        JSONObject otherAttributes = new JSONObject();
//        //其他属性得分
//        otherAttributes.put("score", "注射用卡非佐米在其他属性上的得分为：4 分");
//        //综述
//        otherAttributes.put("summarize", "根据《中国医疗机构药品评价与遴选快速指南（第二版）》中提供的医疗机构药品评价与遴选量化记录表，针对注射用卡非佐米的其他属性进行评价：总分10分，考察项目包括：被评价药品被《国家医保目录》（3分）《国家基本药物目录》（3分）收录情况；是否国家集中采购中标（1分）；是否为原研药、参比制剂或是否通过一致性评价（1分）；生产企业状况（1分）以及全球使用情况（1分）");
//        //otherAttributes表格
//        List<String> otherAttributesTitle = Arrays.asList("药品名称", "原研/参比/一致性评价", "生产厂家", "生产企业状态", "全球使用情况");
//        List<String> otherAttributes1 = Arrays.asList("注射用卡非佐米", "原研药", "Patheon Manufacturing Services, LLC", "Patheon Manufacturing Services, LLC", "中国、美国、欧洲、日本均已上市");
//        otherAttributes.put("table", Arrays.asList(otherAttributesTitle, otherAttributes1));
//        //是否属于国家基本药物
//        boolean essentialMedicines = true;
//        //否被纳入了国家医保目录
//        boolean reimbursementList = true;
//        //是否列为国家集中采购药品
//        boolean procurementOfDrugs = true;
//        otherAttributes.put("essentialMedicines", essentialMedicines);
//        otherAttributes.put("reimbursementList", reimbursementList);
//        otherAttributes.put("procurementOfDrugs", procurementOfDrugs);
//        result.put("otherAttributes", otherAttributes);
//        return result;
    }

    @Override
    public JSONObject suOnAnalysis(String drugName, String disease, String id, String priceId, String specifications, String isCustom, long userId, String drugId, String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        JSONObject report = this.lxGptService.sdyPanel(drugName, disease, id, priceId, specifications, isCustom, userId, drugId, searchId);
        JSONObject result = new JSONObject();
        result.put("id", report.getString("id"));
        result.put("drugName", drugName);
        result.put("disease", disease);
        if (report.getJSONObject("safety") != null && report.getJSONObject("safety").getInteger("vscore") != null) {
            // 安全性得分
            result.put("safetyScore", report.getJSONObject("safety").getString("vscore"));
            // 分析过程
            result.put("safetyProcess", report.getJSONObject("safety").getString("reason"));
        } else {
            result.put("safetyScore", "");
            result.put("safetyProcess", "");
        }
        if (report.getJSONObject("effectiveness") != null && report.getJSONObject("effectiveness").getInteger("vscore") != null) {
            // 有效性得分
            result.put("effectivenessScore", report.getJSONObject("effectiveness").getString("vscore"));
            result.put("effectivenessProcess", report.getJSONObject("effectiveness").getString("reason"));
        } else {
            result.put("effectivenessScore", "");
            result.put("effectivenessProcess", "");
        }
        if (report.getJSONObject("suitability") != null && report.getJSONObject("suitability").getInteger("vscore") != null) {
            // 适宜性得分
            result.put("suitabilityScore", report.getJSONObject("suitability").getString("vscore"));
            result.put("suitabilityProcess", report.getJSONObject("suitability").getString("reason"));
        } else {
            result.put("suitabilityScore", "");
            result.put("suitabilityProcess", "");
        }
        if (report.getJSONObject("overallSummary") != null && report.getJSONObject("overallSummary").getString("comprehensiveScore") != null) {
            result.put("totalScore", report.getJSONObject("overallSummary").getString("comprehensiveScore"));
        } else {
            Integer safetyScore = JSONObject.parseObject((String) result.get("safetyScore"), Integer.class);
            Integer effectivenessScore = JSONObject.parseObject((String) result.get("effectivenessScore"), Integer.class);
            Integer suitabilityScore = JSONObject.parseObject((String) result.get("suitabilityScore"), Integer.class);
            Integer totalScore = safetyScore + effectivenessScore + suitabilityScore;
            result.put("totalScore", totalScore);
        }
        return result;
    }


    @Override
    public JSONObject guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId,
                                      String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        JSONObject report = this.lxGptService.guidePanel(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId);
        JSONObject result = new JSONObject();
        result.put("id", report.getString("id"));
        result.put("drugName", drugName);
        result.put("disease", disease);
        if (report.getJSONObject("safety") != null && report.getJSONObject("safety").getString("vscore") != null) {
            // 安全性得分
            result.put("safetyScore", report.getJSONObject("safety").getString("vscore"));
            // 分析过程
            result.put("safetyProcess", report.getJSONObject("safety").getString("reason"));
        } else {
            result.put("safetyScore", "");
            result.put("safetyProcess", "");
        }
        if (report.getJSONObject("effectiveness") != null && report.getJSONObject("effectiveness").getString("vscore") != null) {
            // 有效性得分
            result.put("effectivenessScore", report.getJSONObject("effectiveness").getString("vscore"));
            result.put("effectivenessProcess", report.getJSONObject("effectiveness").getString("reason"));
        } else {
            result.put("effectivenessScore", "");
            result.put("effectivenessProcess", "");
        }
        if (report.getJSONObject("pharmaceuticalCharacteristics") != null && report.getJSONObject("pharmaceuticalCharacteristics").getString("vscore") != null) {
            // 适宜性得分
            result.put("pharmacyScore", report.getJSONObject("pharmaceuticalCharacteristics").getString("vscore"));
            result.put("pharmacyProcess", report.getJSONObject("pharmaceuticalCharacteristics").getString("summarize"));
        } else {
            result.put("pharmacyScore", "");
            result.put("pharmacyProcess", "");
        }

        if (report.getJSONObject("otherAttributes") != null && report.getJSONObject("otherAttributes").getString("vscore") != null) {
            result.put("otherAttributesScore", report.getJSONObject("otherAttributes").getString("vscore"));
            result.put("otherAttributesProcess", "");
        } else {
            result.put("otherAttributesScore", "0.00");
            result.put("otherAttributesProcess", "");
        }

        if (report.getJSONObject("economical") != null && report.getJSONObject("economical").getString("vscore") != null) {
            result.put("economyScore", report.getJSONObject("economical").getString("vscore"));
            result.put("economyProcess", "");
        } else {
            result.put("economyScore", "0.00");
            result.put("economyProcess", "");
        }
        if (report.getJSONObject("overallSummary") != null && report.getJSONObject("overallSummary").getString("comprehensiveScore") != null) {
            result.put("totalScore", report.getJSONObject("overallSummary").getString("comprehensiveScore"));
        } else {
            // 兜底的  
            Double safetyScore = JSONObject.parseObject((String) result.get("safetyScore"), Double.class);
            Double effectivenessScore = JSONObject.parseObject((String) result.get("effectivenessScore"), Double.class);
            Double pharmacyScore = JSONObject.parseObject((String) result.get("pharmacyScore"), Double.class);
            Double otherAttributesScore = JSONObject.parseObject((String) result.get("otherAttributesScore"), Double.class);
            Double economyScore = JSONObject.parseObject((String) result.get("economyScore"), Double.class);
            BigDecimal totalScore = BigDecimal.valueOf(safetyScore).setScale(2, RoundingMode.HALF_UP)
                    .add(BigDecimal.valueOf(effectivenessScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(pharmacyScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(otherAttributesScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(economyScore).setScale(2, RoundingMode.HALF_UP));
            result.put("totalScore", totalScore);
        }
        return result;
    }

    @Override
    public JSONObject suOnAnalysisApp(String drugName, String disease, String id, String priceId, String specifications, String isCustom, long userId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        JSONObject result = new JSONObject();
        JSONObject report = this.lxGptService.sdyPanelApp(drugName, disease, id, priceId, specifications, isCustom, userId);
        Boolean isExist = this.redisTemplate.hasKey("gpt:" + id + ":" + 0);
        int count = 0;
        if (Objects.nonNull(isExist) && isExist) {
            // 这里有风险
            while (Objects.isNull(redisTemplate.opsForValue().get("score:" + CommonConstants.VARIOUS_SCORE + ":" + id))) {
//                Long surplusTime = this.redisTemplate.getExpire("gpt:" + id + ":" + 0);
                try {
                    Thread.sleep(5000);
                    count++;
                } catch (InterruptedException e) {
                    log.error(e.getMessage(), e);
                }
                // 10分之后
                if (count == 120) {
                    redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, new JSONObject());
                }
            }
            result = (JSONObject) redisTemplate.opsForValue().get("score:" + CommonConstants.VARIOUS_SCORE + ":" + id);

        }
        result.put("content", report.getJSONArray("content"));
        return result;
    }

    @Value("${sys.isDev}")
    private String isDev;


    @Override
    public JSONObject guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        JSONObject result = new JSONObject();
        JSONObject report = this.lxGptService.guidePanelApp(drugName, disease, specifications, id, priceId, userId, isCustom);
        Boolean isExist = this.redisTemplate.hasKey("gpt:" + id + ":" + 0);
        int count = 0;
        if (Objects.nonNull(isExist) && isExist) {
            // 这里有风险
            while (Objects.isNull(redisTemplate.opsForValue().get("score:" + CommonConstants.VARIOUS_SCORE + ":" + id))) {
//                Long surplusTime = this.redisTemplate.getExpire("gpt:" + id + ":" + 0);
                try {
                    Thread.sleep(5000);
                    count++;
                } catch (InterruptedException e) {
                    log.error(e.getMessage(), e);
                }
                // 10分之后
                if (count == 120) {
                    redisTemplate.opsForValue().set("score:" + CommonConstants.VARIOUS_SCORE + ":" + id, new JSONObject());
                }
            }
            result = (JSONObject) redisTemplate.opsForValue().get("score:" + CommonConstants.VARIOUS_SCORE + ":" + id);
        }
        result.put("content", report.getJSONArray("content"));
        return result;
    }


    @Override
    public void guideAppAsynchronous(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, HttpServletRequest request, String token, Boolean x) {

        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        Date startDate = new Date();

        JSONObject report = this.lxGptService.guidePanelApp(drugName, disease, specifications, id, priceId, userId, isCustom);
        JSONObject dataJson = new JSONObject();
        dataJson.put("id", id);
        dataJson.put("userId", userId);
        dataJson.put("token", token);
        dataJson.put("type", "药品遴选报告");
        String s = drugName.replaceAll("\\.", "");
        dataJson.put("name", s + "治疗" + disease + "临床综合评价报告" + ".doc");
        dataJson.put("url", downloadUrl + "/api-evimed/evaluation-api/guide-download-word?id=" + id);
        Date endDate = new Date();
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        dataJson.put("startTime", format.format(startDate));
        dataJson.put("endTime", format.format(endDate));
        if (x) {
            kafkaSender.sendReportInfo(dataJson);
        }


    }


    @Override
    public void guideAppAsynchronousTr(String drugName, String disease, String id, String priceId,
                                       long userId, String drugId, String searchId, String token, Boolean x) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }

        Date startDate = new Date();
        Object report = traditionalMedicineService.guideOnAnalysisV2App(drugName, disease, null, id, priceId, userId, null, drugId, searchId);
        JSONObject dataJson = new JSONObject();
        dataJson.put("id", id);
        dataJson.put("userId", userId);
        dataJson.put("token", token);
        dataJson.put("type", "药品遴选报告");
        String s = drugName.replaceAll("\\.", "");
        dataJson.put("name", s + "临床综合评价报告" + ".doc");
        dataJson.put("url", downloadUrl + "/api-evimed/evaluation-api/traditional/download-word?id=" + id);
        Date endDate = new Date();
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        dataJson.put("startTime", format.format(startDate));
        dataJson.put("endTime", format.format(endDate));
        if (x) {
            kafkaSender.sendReportInfo(dataJson);
        }


    }


    @Override
    public void guideAppAsynchronousx(String idx, long userId, HttpServletRequest request, String finalToken, String ids, Date date, boolean istr) {


        JSONObject dataJson = new JSONObject();
        dataJson.put("id", idx);
        dataJson.put("userId", userId);
        dataJson.put("token", finalToken);
        dataJson.put("type", "药品遴选报告");
        dataJson.put("name", "药品临床综合评价报告" + ".doc");
        if (!istr) {
            dataJson.put("url", downloadUrl + "/api-evimed/evaluation-api/guide-download-words?id=" + ids);
        } else {
            dataJson.put("url", downloadUrl + "/api-evimed/evaluation-api/traditional/download-words?ids=" + ids);
        }
        Date endDate = new Date();
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        dataJson.put("startTime", format.format(date));
        dataJson.put("endTime", format.format(endDate));
        kafkaSender.sendReportInfo(dataJson);


    }

    @Override
    public void calculateTotalScore(JSONObject variousScore, JSONObject report, String drugName, String disease) {
        variousScore.put("id", report.getString("id"));
        variousScore.put("drugName", drugName);
        variousScore.put("disease", disease);
        if (report.getJSONObject("safety") != null && report.getJSONObject("safety").getString("vscore") != null) {
            // 安全性得分
            variousScore.put("safetyScore", report.getJSONObject("safety").getString("vscore"));
            // 分析过程
            variousScore.put("safetyProcess", report.getJSONObject("safety").getString("reason"));
        } else {
            variousScore.put("safetyScore", "");
            variousScore.put("safetyProcess", "");
        }
        if (report.getJSONObject("effectiveness") != null && report.getJSONObject("effectiveness").getString("vscore") != null) {
            // 有效性得分
            variousScore.put("effectivenessScore", report.getJSONObject("effectiveness").getString("vscore"));
            variousScore.put("effectivenessProcess", report.getJSONObject("effectiveness").getString("reason"));
        } else {
            variousScore.put("effectivenessScore", "");
            variousScore.put("effectivenessProcess", "");
        }
        if (report.getJSONObject("pharmaceuticalCharacteristics") != null && report.getJSONObject("pharmaceuticalCharacteristics").getString("vscore") != null) {
            // 适宜性得分
            variousScore.put("pharmacyScore", report.getJSONObject("pharmaceuticalCharacteristics").getString("vscore"));
            variousScore.put("pharmacyProcess", report.getJSONObject("pharmaceuticalCharacteristics").getString("summarize"));
        } else {
            variousScore.put("pharmacyScore", "");
            variousScore.put("pharmacyProcess", "");
        }

        if (report.getJSONObject("otherAttributes") != null && report.getJSONObject("otherAttributes").getString("vscore") != null) {
            variousScore.put("otherAttributesScore", report.getJSONObject("otherAttributes").getString("vscore"));
            variousScore.put("otherAttributesProcess", "");
        } else {
            variousScore.put("otherAttributesScore", "0.00");
            variousScore.put("otherAttributesProcess", "");
        }

        if (report.getJSONObject("economical") != null && report.getJSONObject("economical").getString("vscore") != null) {
            variousScore.put("economyScore", report.getJSONObject("economical").getString("vscore"));
            variousScore.put("economyProcess", "");
        } else {
            variousScore.put("economyScore", "0.00");
            variousScore.put("economyProcess", "");
        }
        if (report.getJSONObject("overallSummary") != null && report.getJSONObject("overallSummary").getString("comprehensiveScore") != null) {
            variousScore.put("totalScore", report.getJSONObject("overallSummary").getString("comprehensiveScore"));
        } else {
            Double safetyScore = JSONObject.parseObject((String) variousScore.get("safetyScore"), Double.class);
            Double effectivenessScore = JSONObject.parseObject((String) variousScore.get("effectivenessScore"), Double.class);
            Double pharmacyScore = JSONObject.parseObject((String) variousScore.get("pharmacyScore"), Double.class);
            Double otherAttributesScore = JSONObject.parseObject((String) variousScore.get("otherAttributesScore"), Double.class);
            Double economyScore = JSONObject.parseObject((String) variousScore.get("economyScore"), Double.class);
            BigDecimal totalScore = BigDecimal.valueOf(safetyScore).setScale(2, RoundingMode.HALF_UP)
                    .add(BigDecimal.valueOf(effectivenessScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(pharmacyScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(otherAttributesScore).setScale(2, RoundingMode.HALF_UP))
                    .add(BigDecimal.valueOf(economyScore).setScale(2, RoundingMode.HALF_UP));
            variousScore.put("totalScore", totalScore);
        }
    }

    @Override
    public void calculateTotalScoreSdy(JSONObject variousScore, JSONObject report, String drugName, String disease) {
        variousScore.put("id", report.getString("id"));
        variousScore.put("drugName", drugName);
        variousScore.put("disease", disease);
        if (report.getJSONObject("safety") != null && report.getJSONObject("safety").getInteger("vscore") != null) {
            // 安全性得分
            variousScore.put("safetyScore", report.getJSONObject("safety").getString("vscore"));
            // 分析过程
            variousScore.put("safetyProcess", report.getJSONObject("safety").getString("reason"));
        } else {
            variousScore.put("safetyScore", "");
            variousScore.put("safetyProcess", "");
        }
        if (report.getJSONObject("effectiveness") != null && report.getJSONObject("effectiveness").getInteger("vscore") != null) {
            // 有效性得分
            variousScore.put("effectivenessScore", report.getJSONObject("effectiveness").getString("vscore"));
            variousScore.put("effectivenessProcess", report.getJSONObject("effectiveness").getString("reason"));
        } else {
            variousScore.put("effectivenessScore", "");
            variousScore.put("effectivenessProcess", "");
        }
        if (report.getJSONObject("suitability") != null && report.getJSONObject("suitability").getInteger("vscore") != null) {
            // 适宜性得分
            variousScore.put("suitabilityScore", report.getJSONObject("suitability").getString("vscore"));
            variousScore.put("suitabilityProcess", report.getJSONObject("suitability").getString("reason"));
        } else {
            variousScore.put("suitabilityScore", "");
            variousScore.put("suitabilityProcess", "");
        }
        if (report.getJSONObject("overallSummary") != null && report.getJSONObject("overallSummary").getString("comprehensiveScore") != null) {
            variousScore.put("totalScore", report.getJSONObject("overallSummary").getString("comprehensiveScore"));
        } else {
            Integer safetyScore = JSONObject.parseObject((String) variousScore.get("safetyScore"), Integer.class);
            Integer effectivenessScore = JSONObject.parseObject((String) variousScore.get("effectivenessScore"), Integer.class);
            Integer suitabilityScore = JSONObject.parseObject((String) variousScore.get("suitabilityScore"), Integer.class);
            Integer totalScore = safetyScore + effectivenessScore + suitabilityScore;
            variousScore.put("totalScore", totalScore);
        }
    }

    /**
     * 存储用户 自定义以及选择的同义词
     *
     * @param synonym 实体类
     * @param userId  用户id
     */
    @Override
    public void saveSynonym(List<SynonymVo> synonym, long userId) {
        if (CollUtil.isNotEmpty(synonym)) {
            String redis_key = "synonym:" + userId;
            String value = JSON.toJSONString(synonym);
            RedisUtils.set(redis_key, value);
        }
    }

    @Override
    public Object drugAdd(DrugAddDto drugAddDto, Long userId) {
        drugAddDto.setUserId(userId);
        String searchId = drugAddDto.getSearchId();
        String drugId = drugAddDto.getDrugId();
        mongoTemplate.remove(new Query(Criteria.where("searchId").is(searchId).and("drugId").is(drugId)), DrugAddDto.class);
        DrugAddDto save = mongoTemplate.save(drugAddDto);

        return save;
    }

    private String getTxt(JSONArray list) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(list)) {
            for (JSONObject drugContent : list.toJavaList(JSONObject.class)) {
                if (ContentTagEnum.TXT.getType().equals(drugContent.getString("tag"))) {
                    stringBuilder.append(drugContent.getString("content"));
                    stringBuilder.append("\n");
                }
            }
//            if (stringBuilder.length() >= 2) {
//                stringBuilder.delete(stringBuilder.length() - 2, stringBuilder.length());
//            }
            return stringBuilder.toString();
        } else {
            return "";
        }
    }

    String regEx_script = "<script[^>]*?>[\\s\\S]*?<\\/script>";// 定义script的正则表达式

    String regEx_style = "<style[^>]*?>[\\s\\S]*?<\\/style>";// 定义style的正则表达式

    String regEx_html = "<[^>]+>";// 定义HTML标签的正则表达式


    private String delHTMLTag(List<DrugContent> list) {

        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(list)) {
            try {
                for (DrugContent drugContent : list) {
                    if (ContentTagEnum.TXT.getType().equals(drugContent.getTag())) {
                        stringBuilder.append(drugContent.getContent());
                        stringBuilder.append("\n");
                    }
                }
            } catch (Exception e) {
                log.error("*****************delHTMLTag error:{}*************", list.toString());
                return "";
            }

//            if (stringBuilder.length() >= 2) {
//                stringBuilder.delete(stringBuilder.length() - 2, stringBuilder.length());
//            }
            return stringBuilder.toString();
        } else {
            return "";
        }


    }


    /**
     * 初始化 drugInfoNew
     *
     * @return
     */


    @Override
    public DrugAddVo drugData(String searchId, String drugId) {

        DrugAddDto drugAddDto = mongoTemplate.findOne(Query.query(Criteria.where("searchId").is(searchId).and("drugId").is(drugId)), DrugAddDto.class);
        DrugInfoNew drugInfo1 = mongoTemplate.findOne(Query.query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
        String register = drugInfo1.getRegister();
        if (register != null) {
            DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
            if (ObjectUtil.isNotEmpty(approveCode)) {
                if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                    drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                }
                if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                    drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                }
                if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                    drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                }
                if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                    drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                }
                if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                    drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                }
                if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                    drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                }
                if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                    drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                }
                if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                    drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                }
                if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                    drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                }
                if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                    drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                }
                if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                    drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                }
                if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                    drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                }
                if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                    drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                }
                if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                    drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                }


            }
        }

        if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
            JSONObject evaluationMedicine = getHeliYongYao(drugInfo1.getDrugZh());
            if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                    drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));

                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                    drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));

                }

                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                }

            }
        }
        DrugAddVo drugAddVo = new DrugAddVo();
        if (ObjectUtils.isEmpty(drugAddDto)) {
            BeanUtils.copyProperties(drugInfo1, drugAddVo);
            if (StringUtils.isNotEmpty(drugInfo1.getCommonAdverseReactions())) {
                drugAddVo.setModerateAdverseReaction(drugInfo1.getCommonAdverseReactions());
            }
            if (StringUtils.isNotEmpty(drugInfo1.getSeriousAdverseRactions())) {
                drugAddVo.setSevereAdverseReaction(drugInfo1.getSeriousAdverseRactions());
            }
        } else {
            BeanUtils.copyProperties(drugAddDto, drugAddVo);
        }
        ArrayList<String> strings = new ArrayList<>();
        if (StringUtils.isNotEmpty(drugInfo1.getDrugName())) {
            strings.add("drugName");
        }
        if (StringUtils.isNotEmpty(drugInfo1.getManufacturer())) {
            strings.add("manufacturer");
        }
        if (StringUtils.isNotEmpty(drugInfo1.getIndication())) {
            strings.add("indication");
        }
        if (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh())) {
            strings.add("communityNameZh");
        }
        if (StringUtils.isNotEmpty(drugInfo1.getSpecifications())) {
            strings.add("specifications");
        }
        drugAddVo.setNoChange(strings);
        drugAddVo.setDrugId(drugId);
        return drugAddVo;
    }

    /**
     * 转化数据库
     *
     * @param hasData
     */
    @Override
    public void getInstructionsDeduplicated(Long hasData) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_TEST_DATA")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), Instructions.class);
        long page = (instructionsCleaning - hasData) / 100 + 1;
        Query query = new Query();
        Criteria criteria = new Criteria();
        query.addCriteria(criteria);
        for (int i = 0; i < page; i++) {
            try {
                List<Instructions> instructionsDeduplicated = dataMongoTemplate.find(query.skip(i * 100 + hasData).limit(100), Instructions.class);
                // mongo
                List<DrugInfoNew> drugInfos = new ArrayList<>();
                // es
                List<DrugAndIndicationIndex> indexList = new ArrayList<>();
                for (Instructions instructionsDeduplicated1 : instructionsDeduplicated) {
                    DrugInfoNew drugInfoNew = new DrugInfoNew();
                    DrugAndIndicationIndex DrugAndIndicationIndex = new DrugAndIndicationIndex();
                    // id
                    getDrugInfoMap(drugInfoNew, instructionsDeduplicated1, DrugAndIndicationIndex);
                    // 组装完毕
                    drugInfos.add(drugInfoNew);
                    indexList.add(DrugAndIndicationIndex);
                }
                // 写入
                putDrugInfo(drugInfos, indexList);
            } catch (Exception e) {
                // mongo
                List<DrugInfoNew> drugInfos = new ArrayList<>();
                // es
                List<DrugAndIndicationIndex> indexList = new ArrayList<>();
                for (int j = 0; j < 100; j++) {
                    try {
                        List<Instructions> instructionsDeduplicated = dataMongoTemplate.find(query.skip(i * 100 + j + hasData).limit(1), Instructions.class);
                        DrugInfoNew drugInfoNew = new DrugInfoNew();
                        DrugAndIndicationIndex DrugAndIndicationIndex = new DrugAndIndicationIndex();
                        getDrugInfoMap(drugInfoNew, instructionsDeduplicated.get(0), DrugAndIndicationIndex);
                        drugInfos.add(drugInfoNew);
                        indexList.add(DrugAndIndicationIndex);
                    } catch (Exception e1) {
                        List<JSONObject> jsonObjects = dataMongoTemplate.find(query.skip(i * 100 + j + hasData).limit(1), JSONObject.class, "instructions_complete");
                        log.error("*********第" + i + "页，第" + j + "条数据出错{}*********错误原因{}", jsonObjects.get(0).get("_id"), e1);
                    }
                }
                putDrugInfo(drugInfos, indexList);
            }

            System.out.println("加载了条数：" + (i + 1) * 100);

        }
    }

    @Override
    public void insUpdate(String id) {
        String[] split = id.split(",");
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_TEST_DATA")));
        Instructions id1 = dataMongoTemplate.findOne(Query.query(Criteria.where("_id").is(split[0])), Instructions.class);
        if (ObjectUtils.isNotEmpty(id1)) {
            DrugInfoNew drugInfoNew = new DrugInfoNew();
            DrugAndIndicationIndex DrugAndIndicationIndex = new DrugAndIndicationIndex();
            getDrugInfoMap(drugInfoNew, id1, DrugAndIndicationIndex);
            mongoTemplate.remove(Query.query(Criteria.where("_id").is(split[1])), DrugInfoNew.class);
            elasticsearchRestTemplate.delete(split[1], DrugAndIndicationIndex.class);
            DrugInfoNew save = mongoTemplate.save(drugInfoNew);
            DrugAndIndicationIndex save1 = elasticsearchRestTemplate.save(DrugAndIndicationIndex);
            System.out.println(save);
            System.out.println(save1);
        }
    }


    @Deprecated
    public DrugDataSdyVo drugDataSdy(String disease, String searchId, String drugIds) {
        HashMap<String, Future<Boolean>> theardHashMap = new HashMap<>();
        String[] ids = drugIds.split(",");
        String[] split = disease.split(";");
        // 异步数据
        HashMap<String, Future<Boolean>> threadMap = new HashMap<>();
        DrugDataSdyVo drugDataSdyVo = new DrugDataSdyVo();
        ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
        RelatedVo relatedVo = new RelatedVo();
        drugDataSdyVo.setRelated(relatedVo);
        ArrayList<InstructionsInfoVo> instructionsInfoVos = new ArrayList<>();
        relatedVo.setInstructionsInfo(instructionsInfoVos);
        relatedVo.setGuide(guidelinesVos1);
        for (String drugId : ids) {


            // 说明书相关
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            DrugAddDto drugAdd = null;
            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }
            drugInfo1.setDrugName(drugNameDetail);
            ArrayList<String> drugs = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugs, drugInfo1);
            DataVo<AdverseReactionVo> adDataVo = new DataVo<>(drugInfo1);
            AdverseReactionVo adverseReactionVo = new AdverseReactionVo();
            adverseReactionVo.setAdverseReaction(drugInfo1.getAdverseReaction());
            adDataVo.setData(adverseReactionVo);
            drugDataSdyVo.getAdverseReaction().add(adDataVo);
            // 配方
            DataVo<String> componentDataVo = new DataVo<>(drugInfo1);
            componentDataVo.setData(drugInfo1.getDrugType());
            drugDataSdyVo.getComponent().add(componentDataVo);
            componentDataVo.setData(drugInfo1.getIngredient());
            // 与同类药品相比的优势（安全性）

            Future<Boolean> submit = threadPoolTaskExecutor.submit(() -> {
                adverseReactionVo.setSafeAdvantage(xiaoling(drugInfo1.getDrugName(), drugInfo1.getDrugName() + "与其他同类型的药品相比有什么安全性方面的优势"));

                return true;
            });
            theardHashMap.put("safeAdvantage" + drugId, submit);

            // 临床疗效的优势
            DataVo<String> advantageDataVo = new DataVo<>(drugInfo1);
            drugDataSdyVo.getTreatmentAdvantage().add(advantageDataVo);
            Future<Boolean> submit1 = threadPoolTaskExecutor.submit(() -> {
                advantageDataVo.setData(xiaoling(drugInfo1.getDrugName(), drugInfo1.getDrugName() + "与同类型的药品相比 临床治疗上 有什么优势"));
                return true;
            });
            theardHashMap.put("treatmentAdvantage" + drugId, submit1);
            InstructionsInfoVo instructionsInfoVo = new InstructionsInfoVo();
            instructionsInfoVo.setTitle(drugNameDetail);
            instructionsInfoVo.setUrl(getInstructionUrl(drugInfo1));
            instructionsInfoVos.add(instructionsInfoVo);

            // 指南相关
            for (String s : split) {
                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);
                ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
                DataVo<List<GuidelinesVo>> guidelinesVoDataVo = new DataVo<>(drugInfo1.getDrugName() + "用于" + s, drugInfo1.getId(), guidelinesVos1, new ArrayList<>());
                drugDataSdyVo.getGuidelines().add(guidelinesVoDataVo);
                ArrayList<GuidelinesVo> guidelinesVos2 = new ArrayList<>();
                guidelinesVoDataVo.setData(guidelinesVos);
                guidelinesVoDataVo.setDataOther(guidelinesVos2);
                Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugs, drugInfo1.getDrugZh(), diseases, disease);
                    if (CollUtil.isNotEmpty(guideVOList)) {
                        for (GuideVO guideVO : guideVOList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(guideVO.getPdf_txt());
                            guidelinesVo.setZdz(guideVO.getZdz());
                            guidelinesVo.setTitle(guideVO.getTitle());
                            guidelinesVo.setFdaDate(guideVO.getFbdate());
                            guidelinesVo.setType("1");
                            guidelinesVo.setId(guideVO.getId());
                            guidelinesVo.setIsPaper(guideVO.getIsPaper());
                            guidelinesVos.add(guidelinesVo);
                            guidelinesVos1.add(guidelinesVo);
                        }

                    }
                    return true;
                });
                threadMap.put("guideResult" + drugId, guideResult);

            }


        }

        for (Map.Entry<String, Future<Boolean>> futureEntry : threadMap.entrySet()) {
            try {
                futureEntry.getValue().get();
            } catch (InterruptedException e) {
                throw new RuntimeException(e);
            } catch (ExecutionException e) {
                throw new RuntimeException(e);
            }
        }


        return drugDataSdyVo;
    }


    @Override
    @Deprecated
    public List<DrugDisSdy> drugSdyTal(String disease, String searchId, String drugIds) {
        ArrayList<DrugDisSdy> drugDisSdies = new ArrayList<>();
        HashMap<String, Future<Boolean>> theardHashMap = new HashMap<>();
        String[] ids = drugIds.split(",");
        String[] split = disease.split(";");
        // 异步数据
        HashMap<String, Future<Boolean>> threadMap = new HashMap<>();
        DrugDataSdyVo drugDataSdyVo = new DrugDataSdyVo();
        ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
        RelatedVo relatedVo = new RelatedVo();
        drugDataSdyVo.setRelated(relatedVo);
        ArrayList<InstructionsInfoVo> instructionsInfoVos = new ArrayList<>();
        relatedVo.setInstructionsInfo(instructionsInfoVos);
        relatedVo.setGuide(guidelinesVos1);
        HashMap<String, String> safeAdvantages = new HashMap<>();
        HashMap<String, String> advantages = new HashMap<>();

        for (String drugId : ids) {


            // 说明书相关
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            DrugAddDto drugAdd = null;
            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }
            drugInfo1.setDrugName(drugNameDetail);
            ArrayList<String> drugs = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugs, drugInfo1);
            DataVo<AdverseReactionVo> adDataVo = new DataVo<>(drugInfo1);
            AdverseReactionVo adverseReactionVo = new AdverseReactionVo();
            adverseReactionVo.setAdverseReaction(drugInfo1.getAdverseReaction());
            adDataVo.setData(adverseReactionVo);
            drugDataSdyVo.getAdverseReaction().add(adDataVo);
            // 配方

            // 与同类药品相比的优势（安全性）

            Future<Boolean> submit = threadPoolTaskExecutor.submit(() -> {
                String xiaoling = xiaoling(drugInfo1.getDrugName(), drugInfo1.getDrugName() + "与其他同类型的药品相比有什么安全性方面的优势");
                safeAdvantages.put(drugId, xiaoling);
                return true;
            });
            theardHashMap.put("safeAdvantage" + drugId, submit);

            // 临床疗效的优势
            DataVo<String> advantageDataVo = new DataVo<>(drugInfo1);
            drugDataSdyVo.getTreatmentAdvantage().add(advantageDataVo);
            Future<Boolean> submit1 = threadPoolTaskExecutor.submit(() -> {
                String xiaoling = xiaoling(drugInfo1.getDrugName(), drugInfo1.getDrugName() + "与同类型的药品相比 临床治疗上 有什么优势");
                advantageDataVo.setData(xiaoling);
                return true;
            });
            theardHashMap.put("treatmentAdvantage" + drugId, submit1);
            InstructionsInfoVo instructionsInfoVo = new InstructionsInfoVo();
            instructionsInfoVo.setTitle(drugNameDetail);
            instructionsInfoVo.setUrl(getInstructionUrl(drugInfo1));
            instructionsInfoVos.add(instructionsInfoVo);

            // 指南相关
            for (String s : split) {
                DrugDisSdy drugDisSdy = new DrugDisSdy();
                drugDisSdies.add(drugDisSdy);
                drugDisSdy.setDrugName(drugInfo1.getDrugName());
                drugDisSdy.setDisease(s);
                drugDisSdy.setDrugId(drugId);
                drugDisSdy.setComponent(drugInfo1.getIngredient());
                drugDisSdy.setTitle(drugNameDetail + " 用于 " + s);
                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);
                ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
                drugDisSdy.setGuide(guidelinesVos);
                DataVo<List<GuidelinesVo>> guidelinesVoDataVo = new DataVo<>(drugInfo1.getDrugName() + "用于" + s, drugInfo1.getId(), guidelinesVos1, new ArrayList<>());
                drugDataSdyVo.getGuidelines().add(guidelinesVoDataVo);
                ArrayList<GuidelinesVo> guidelinesVos2 = new ArrayList<>();
                guidelinesVoDataVo.setData(guidelinesVos);
                guidelinesVoDataVo.setDataOther(guidelinesVos2);
                Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugs, drugInfo1.getDrugZh(), diseases, disease);
                    if (CollUtil.isNotEmpty(guideVOList)) {
                        for (GuideVO guideVO : guideVOList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(guideVO.getPdf_txt());
                            guidelinesVo.setZdz(guideVO.getZdz());
                            guidelinesVo.setTitle(guideVO.getTitle());
                            guidelinesVo.setFdaDate(guideVO.getFbdate());
                            guidelinesVo.setType("1");
                            guidelinesVo.setId(guideVO.getId());
                            guidelinesVo.setIsPaper(guideVO.getIsPaper());
                            guidelinesVos.add(guidelinesVo);

                        }
                    }
                    return true;
                });
                threadMap.put("guideResult" + drugId, guideResult);

            }


        }

        for (Map.Entry<String, Future<Boolean>> futureEntry : threadMap.entrySet()) {
            try {
                futureEntry.getValue().get();
            } catch (InterruptedException e) {
                throw new RuntimeException(e);
            } catch (ExecutionException e) {
                throw new RuntimeException(e);
            }
        }

        safeAdvantages.forEach((k, v) -> {
            for (DrugDisSdy drugDisSdy : drugDisSdies) {
                if (drugDisSdy.getDrugId().equals(k)) {
                    drugDisSdy.setSafeAdvantage(v);
                }
            }
        });
        advantages.forEach((k, v) -> {
            for (DrugDisSdy drugDisSdy : drugDisSdies) {
                if (drugDisSdy.getDrugId().equals(k)) {
                    drugDisSdy.setTreatmentAdvantage(v);
                }
            }
        });


        return drugDisSdies;
    }


    @Override
    @Deprecated
    public List<DrugDisSdy> drugSdyTalPlus(String disease, String searchId, String drugIds) {
        ArrayList<DrugDisSdy> drugDisSdies = new ArrayList<>();
        HashMap<String, Future<Boolean>> theardHashMap = new HashMap<>();
        String[] ids = drugIds.split(",");
        String[] split = disease.split(";");
        // 异步数据
        HashMap<String, Future<Boolean>> threadMap = new HashMap<>();
        HashMap<String, String> sdyTotal = new HashMap<>();
        for (String drugId : ids) {
            // 说明书相关
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            DrugAddDto drugAdd = null;
            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }

            String register = drugInfo1.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }


                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo1.setPdf(approveCode.getPdf());
                    }

                }
            }


            // 合理用药
            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
                JSONObject evaluationMedicine = getHeliYongYao(drugInfo1.getDrugZh());
                if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                        drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));

                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                        drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));

                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                    }

                    if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                            (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                    CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                        drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                        drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                        drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                    }


                }

            }
            drugInfo1.setDrugName(drugNameDetail);
            ArrayList<String> drugs = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugs, drugInfo1);
            AdverseReactionVo adverseReactionVo = new AdverseReactionVo();
            adverseReactionVo.setAdverseReaction(drugInfo1.getSeriousAdverseRactions());
            // 配方
            DataVo<String> componentDataVo = new DataVo<>(drugInfo1);
            componentDataVo.setData(drugInfo1.getDrugType());

            // 与同类药品相比的优势（安全性）
            sdyTotal.put(drugInfo1.getDrugName() + "sa", drugInfo1.getDrugName() + "与其他同类型的药品相比有什么安全性方面的优势");
            // 临床疗效的优势
            sdyTotal.put(drugInfo1.getDrugName() + "tr", drugInfo1.getDrugName() + "与同类型的药品相比 临床治疗上 有什么优势");
            // 指南相关
            for (String s : split) {
                DrugDisSdy drugDisSdy = new DrugDisSdy();
                drugDisSdies.add(drugDisSdy);
                drugDisSdy.setAdverseReaction(StringUtils.isNotEmpty(drugInfo1.getSeriousAdverseRactions()) ?
                        drugInfo1.getSeriousAdverseRactions() : drugInfo1.getAdverseReaction());
                drugDisSdy.setDrugName(drugInfo1.getDrugName());
                drugDisSdy.setDisease(s);
                drugDisSdy.setDrugId(drugId);
                drugDisSdy.setTitle(drugNameDetail + " 用于 " + s);
                drugDisSdy.setComponent(drugInfo1.getIngredient());
                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);
                ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
                drugDisSdy.setGuide(guidelinesVos);
                Future<Boolean> guideResult = gptAnalysisThreadPool.submit(() -> {
                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugs, drugInfo1.getDrugZh(), diseases, disease);
                    if (CollUtil.isNotEmpty(guideVOList)) {
                        for (GuideVO guideVO : guideVOList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(guideVO.getPdf_txt());
                            guidelinesVo.setZdz(guideVO.getZdz());
                            guidelinesVo.setTitle(guideVO.getTitle());
                            guidelinesVo.setFdaDate(guideVO.getFbdate());
                            guidelinesVo.setType("1");
                            guidelinesVo.setId(guideVO.getId());
                            guidelinesVo.setIsPaper(guideVO.getIsPaper());
                            guidelinesVo.setShowField(guideVO.getTitle() + "-" + guideVO.getZdz() + "-" + guideVO.getFbdate());
                            guidelinesVos.add(guidelinesVo);

                        }
                    }
                    return true;
                });
                threadMap.put("guideResult" + drugId, guideResult);
            }
        }

        HashMap<String, String> Mapx = new HashMap<>();
        AtomicInteger x = new AtomicInteger(1);
        HashMap<String, String> promptR = new HashMap<>();
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性）：\n");
        sdyTotal.forEach((k, v) -> {
            String key = "问题" + x;
            String prompt = key + "：" + v + "\n";
            stringBuilder.append(prompt);
            String title = "question" + x;
            promptR.put(title, "###" + key + "###的答案(不用显示问题几的标号)");
            Mapx.put(k, title);
            x.incrementAndGet();

        });
        JSONObject responseFormat = getResponseFormat(promptR);

        // 创建子线程执行
        CompletableFuture<Boolean> total = CompletableFuture.supplyAsync(() -> {
            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder.toString(), "检索所有项目", responseFormat, "", null);
            log.info(jsonObject.toJSONString());
            for (DrugDisSdy drugDisSdy : drugDisSdies) {
                try {
                    String inKey = drugDisSdy.getDrugName() + "sa";
                    String in = Mapx.get(inKey);
                    if (in != null) {
                        drugDisSdy.setSafeAdvantage(jsonObject.getString(in));
                    } else {
                        drugDisSdy.setSafeAdvantage("暂无");
                    }
                } catch (Exception e) {
                    drugDisSdy.setSafeAdvantage("暂无");
                    e.printStackTrace();
                }
                try {
                    String clKey = drugDisSdy.getDrugName() + "tr";
                    String cl = Mapx.get(clKey);
                    if (cl != null) {
                        drugDisSdy.setTreatmentAdvantage(jsonObject.getString(cl));
                    } else {
                        drugDisSdy.setTreatmentAdvantage("暂无");
                    }
                } catch (Exception e) {
                    drugDisSdy.setTreatmentAdvantage("暂无");
                    e.printStackTrace();
                }
            }

            return true;
        }, guideAnalysisThreadPool);

        threadMap.put("total", total);

        for (Map.Entry<String, Future<Boolean>> futureEntry : threadMap.entrySet()) {
            try {
                futureEntry.getValue().get();
            } catch (InterruptedException e) {
                throw new RuntimeException(e);
            } catch (ExecutionException e) {
                throw new RuntimeException(e);
            }
        }

        return drugDisSdies;
    }


    public JSONObject getHeliYongYao(String drugs) {
        Criteria criteria = new Criteria();
        criteria.orOperator(
                Criteria.where("NMPAdrugName").is(drugs),
                Criteria.where("drugName").is(drugs),
                Criteria.where("prop1").is(drugs),
                Criteria.where("prop2").is(drugs)
        );
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(criteria), JSONObject.class, "evaluation_medicine_ptopname");

        if (CollUtil.isNotEmpty(jsonObjects)) {
            String drugName = jsonObjects.get(0).getString("drugName");
            JSONObject evaluationMedicine = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName)), JSONObject.class, CommonConstants.REASONABLE_DRUG_TABLE_NAME);
            return evaluationMedicine;
        }

        return null;
    }


    @Override
    public List<Object> getlines(String disease, String searchId, String drugIds) {
        String[] ids = drugIds.split(",");
        ArrayList<Object> objects = new ArrayList<>();
        for (String drugId : ids) {

            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            if (ObjectUtil.isEmpty(drugInfo1)) {
                throw new RuntimeException("未找到药品信息");
            }
            DrugAddDto drugAdd = null;
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }

            String register = drugInfo1.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }

                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo1.setPdf(approveCode.getPdf());
                    }

                }
            }

            String isAdverseReactions = "0";
            // 合理用药
            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
                JSONObject evaluationMedicine = getHeliYongYao(drugInfo1.getDrugZh());
                if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                        drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                        drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                    }

                    if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                            (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                    CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                        drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                        drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                        drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                    }


                }
            }

            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();


            DataVo<InstructionDataVo> instructionDataVoDataVo = new DataVo<>(drugInfo1.getDrugName(), drugInfo1.getId(), new InstructionDataVo(drugInfo1.getPharmacology(),
                    drugInfo1.getPharmacokinetics(), drugInfo1.getAdverseReaction(), drugInfo1.getCommonAdverseReactions(),
                    drugInfo1.getSeriousAdverseRactions(), getInstructionUrl(drugInfo1), drugNameDetail, isAdverseReactions), new InstructionDataVo());
            objects.add(instructionDataVoDataVo);
        }
        return objects;
    }


    @Override
    public List<Object> getlinesSdy(String disease, String searchId, String drugIds) {
        HashMap<String, Future<Boolean>> theardHashMap = new HashMap<>();
        String[] ids = drugIds.split(",");
        ArrayList<Object> objects = new ArrayList<>();
        for (String drugId : ids) {
            // 说明书相关
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            DrugAddDto drugAdd = null;
            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }
            drugInfo1.setDrugName(drugNameDetail);
            DataVo<String> adDataVo = new DataVo<>(drugInfo1);
            adDataVo.setData(drugInfo1.getAdverseReaction());
            objects.add(adDataVo);
        }
        return objects;
    }

    @Override
    public Object getOther(String disease, String searchId, String drugIds) {
        ArrayList<DataVo<OtherVo>> dataVos = new ArrayList<>();
        // 异步数据
        HashMap<String, Future<Boolean>> threadMap = new HashMap<>();
        for (String drugId : drugIds.split(",")) {
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            DataVo<OtherVo> otherVoDataVo = new DataVo<>(drugNameDetail, drugInfo1.getId(), new OtherVo(), new OtherVo());
            dataVos.add(otherVoDataVo);
            OtherVo otherVo = new OtherVo();
            otherVoDataVo.setData(otherVo);
            Future<Boolean> submit = threadPoolTaskExecutor.submit(() -> {
                String query = "请根据知识库分析" + drugInfo1.getManufacturer() + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况";
                String query1 = "请根据药品注册信息、药品评审中信、国家药品监督管理局等官方网站， 以及知识库，分析" + drugInfo1.getDrugName() + "在中国、美国、欧洲、日本四国的上市/获批情况，是否在国内及国外均有销售";
                String manufacturer = xiaoling(drugInfo1.getManufacturer(), query);
                String globalUsage = xiaoling(drugInfo1.getDrugName(), query1);
                otherVo.setManufacturers(manufacturer);
                otherVo.setGlobalUsage(globalUsage);
                return true;
            });
            threadMap.put("submit" + drugId, submit);

        }
        for (Map.Entry<String, Future<Boolean>> futureEntry : threadMap.entrySet()) {
            try {
                futureEntry.getValue().get();
            } catch (InterruptedException e) {
                throw new RuntimeException(e);
            } catch (ExecutionException e) {
                throw new RuntimeException(e);
            }
        }
        return dataVos;
    }


    @Override
    public JSONObject drugDataInfo(String disease, String searchId, String drugIds) {
        String[] ids = drugIds.split(",");
        JSONObject jsonObject = new JSONObject();
        List<Object> objects = new ArrayList<>();
        JSONObject jsonObject1 = new JSONObject();
        ArrayList<JSONObject> drugInfos = new ArrayList<>();
        ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
        ArrayList<GuidelinesVo> literatureVos = new ArrayList<>();

        jsonObject1.put("drugInfo", drugInfos);
        jsonObject1.put("guideInfo", guidelinesVos1);
        jsonObject1.put("literatureInfo", literatureVos);
        jsonObject.put("guide", objects);
        jsonObject.put("rale", jsonObject1);

        HashMap<String, CompletableFuture<Boolean>> threadMap = new HashMap<>();
        DrugDataInfoVo drugDataInfoVo = new DrugDataInfoVo();
        long l1 = System.currentTimeMillis();
        for (String drugId : ids) {
            DrugInfoNew drugInfo = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            if (drugInfo == null) continue;

            ArrayList<String> drugNames = new ArrayList<>();
            GetSynonymsDrugName(drugInfo.getDrugName(), drugNames, drugInfo);

            DrugAddDto drugAdd = null;
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }

            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾病是否可用:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo.setNotes(drugInfo.getNotes() + "\n肾功能异常者：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝病是否可用:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo.setNotes(drugInfo.getNotes() + "\n肝功能异常者：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo.setAdverseReaction(adverseReaction.toString());
                }

            }
            String register = drugInfo.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }

                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo.setPdf(approveCode.getPdf());
                    }

                }
            }

            String drugNameDetail = drugInfo.getDrugName() + (StringUtils.isNotEmpty(drugInfo.getCommunityNameZh()) ? "(" + drugInfo.getCommunityNameZh() + ")" : "") + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer();
            JSONObject jsonObject3 = new JSONObject();
            jsonObject3.put("drugNameDetail", drugNameDetail);
            jsonObject3.put("url", getInstructionUrl(drugInfo));
            drugInfos.add(jsonObject3);

            for (String s : disease.split(";")) {
                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);

                DataVo<List<GuidelinesVo>> guidelinesVoDataVo = new DataVo<>(drugNameDetail + " 用于 " + s, drugInfo.getId(), new ArrayList<>(), new ArrayList<>());
                objects.add(guidelinesVoDataVo);

                CompletableFuture<Boolean> guideResult = CompletableFuture.supplyAsync(() -> {
                    long l = System.currentTimeMillis();
                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, drugInfo.getDrugZh(), diseases, s);
                    if (CollUtil.isNotEmpty(guideVOList)) {
                        for (GuideVO guideVO : guideVOList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(guideVO.getPdf_txt());
                            guidelinesVo.setZdz(guideVO.getZdz());
                            guidelinesVo.setTitle(guideVO.getTitle());
                            guidelinesVo.setFdaDate(guideVO.getFbdate());
                            guidelinesVo.setType("1");
                            guidelinesVo.setId(guideVO.getId());
                            guidelinesVo.setIsPaper(guideVO.getIsPaper());
                            guidelinesVos1.add(guidelinesVo);
                        }
                        guidelinesVoDataVo.setData(guideVOList.stream().map(this::convertToGuidelinesVo).collect(Collectors.toList()));
                        drugDataInfoVo.getGuidelines().add(guidelinesVoDataVo);
                    }
                    long k = System.currentTimeMillis();
                    System.out.println("********************************************耗时1：" + (k - l));
                    return true;
                }, gptAnalysisThreadPool);

////                CompletableFuture<Boolean> literatureResult = CompletableFuture.supplyAsync(() -> {
//                    long l2 = System.currentTimeMillis();
//                    List<Literature> literatureList = lxGptService.queryLiterature(drugInfo.getDrugZh(), drugNames, s, diseases);
//                    if (CollUtil.isNotEmpty(literatureList)) {
//                        for (Literature literature : literatureList) {
//                            GuidelinesVo guidelinesVo = new GuidelinesVo();
//                            guidelinesVo.setContent(literature.getTitleQuestion());
//                            guidelinesVo.setZdz(literature.getJournal());
//                            guidelinesVo.setTitle(literature.getTitle());
//                            guidelinesVo.setFdaDate(literature.getYear());
//                            guidelinesVo.setType("2");
//                            guidelinesVo.setId(literature.getId());
//                            guidelinesVo.setIsPaper(0);
//                            guidelinesVo.setAuthor(literature.getAuthor());
//                            // 中文文献分区
//                            List<String> partition = new ArrayList<>();
//                            if ("zh".equals(literature.getLanguage())) {
//                                List<String> recognizedKernelJournals = literature.getJournalDivision();
//                                if (CollUtil.isNotEmpty(recognizedKernelJournals)) {
//                                    for (String recognizedKernelJournal : recognizedKernelJournals) {
//                                        switch (recognizedKernelJournal) {
//                                            case "Technology":
//                                                partition.add("科技核心");
//                                                break;
//                                            case "Peking University":
//                                                partition.add("北大核心");
//                                                break;
//                                            case "Nanjing University":
//                                                partition.add("南大核心");
//                                                break;
//                                            case "CSCD":
//                                                partition.add("CSCD");
//                                                break;
//                                            default:
//                                                break;
//                                        }
//                                    }
//                                }
//                            }
//                            guidelinesVo.setCore(partition);
//
//                            literatureVos.add(guidelinesVo);
//                        }
//                        guidelinesVoDataVo.setDataOther(literatureList.stream().map(this::convertToGuidelinesVo).collect(Collectors.toList()));
//                        drugDataInfoVo.getGuidelines().add(guidelinesVoDataVo);
//                    }
//                    long k3 = System.currentTimeMillis();
//                    System.out.println("********************************************耗时2：" + (k3 - l2));
////                    return true;
////                }, gptAnalysisThreadPool);

                threadMap.put("guideResult" + drugId, guideResult);
//                threadMap.put("literatureResult" + drugId, literatureResult);
            }
        }
        long k2 = System.currentTimeMillis();
        System.out.println("********************************************耗时3：" + (k2 - l1));
        CompletableFuture.allOf(threadMap.values().toArray(new CompletableFuture[threadMap.size()])).join();
        long l = System.currentTimeMillis();
        System.out.println("********************************************耗时4：" + (l - k2));
        return jsonObject;
    }

    @Override
    public List<DrugDisData> getDataTal(String disease, String searchId, String drugIds) {
        // 中间有效性部分
        // 最后的其他内容
        // 指南list

        ArrayList<DrugDisData> drugDisDatas = new ArrayList<>();
        String[] ids = drugIds.split(",");

        HashMap<String, CompletableFuture<Boolean>> threadMap = new HashMap<>();

        HashMap<String, String> manufacturerMap = new HashMap<>();
        HashMap<String, String> globalUsageMap = new HashMap<>();

        long startTime = System.currentTimeMillis();
        for (String drugId : ids) {
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            if (ObjectUtil.isEmpty(drugInfo1)) {
                throw new RuntimeException("未找到药品信息");
            }
            DrugAddDto drugAdd = null;
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }

            String register = drugInfo1.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }


                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo1.setPdf(approveCode.getPdf());
                    }

                }
            }

            String isAdverseReactions = "0";
            // 合理用药
            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
                JSONObject evaluationMedicine = getHeliYongYao(drugInfo1.getDrugZh());
                if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                        drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                        drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                    }

                    if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                            (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                    CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                        drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                        drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                        drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                    }


                }
            }

            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            InstructionDataVo instructionDataVo = new InstructionDataVo(drugInfo1.getPharmacology(),
                    drugInfo1.getPharmacokinetics(), drugInfo1.getAdverseReaction(), drugInfo1.getCommonAdverseReactions(),
                    drugInfo1.getSeriousAdverseRactions(), getInstructionUrl(drugInfo1), drugNameDetail, isAdverseReactions);

            // 同义词
            ArrayList<String> drugNames = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugNames, drugInfo1);


            for (String s : disease.split(";")) {
                DrugDisData drugDisData = new DrugDisData();
                drugDisData.setDrugId(drugInfo1.getId());
                drugDisData.setDisease(s);
                drugDisData.setTitle(drugNameDetail + " 用于 " + s);
                drugDisData.setInfo(instructionDataVo);

                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);

                CompletableFuture<Boolean> indicationAsync = CompletableFuture.supplyAsync(() -> {
                    try {
                        String doc = xiaoling(drugInfo1.getDrugZh(), "请分析一下在临床研究中，在治疗" + disease + "的药品除了" + drugInfo1.getDrugZh() + "还有哪些？返回结果请这样回答：治疗" + disease + "除了" + drugInfo1.getDrugZh() + "还有...（总结一句话返回）");
                        String xiaoling = xiaoling(drugInfo1.getDrugZh(), "请根据我提供如下内容：" + doc + "，以及你所知道的其他数据，判断临床上" + drugInfo1.getDrugZh() + "治疗" + disease + "时，属于临床必需首选药品，或者是临床必需次选药品，还是可选药品较多？");
                        drugDisData.setIndication(doc + "\n" + xiaoling);
                    } catch (Exception e) {
                        log.error("xiaoling error", e);
                    }
                    return true;
                }, threadPoolTaskExecutor);

                threadMap.put("indicationAsync" + drugInfo1.getId() + disease, indicationAsync);


                // 临床疗效
                DataVo1<String> clinicalEffect = new DataVo1<>(drugNameDetail + " 用于 " + s, drugInfo1.getId());

                CompletableFuture<Boolean> clinicalEffectAsync = CompletableFuture.supplyAsync(() -> {
                    try {
                        String doc = xiaoling(drugInfo1.getDrugZh(), "假设你现在是个临床试验研究员，请回答药品：" + drugInfo1.getDrugZh() + "在治疗" + disease + "的临床疗效方面上，经常以哪些结局指标作为观察疗效的指标（请分别罗列主要疗效终点指标以及次要疗效终点指标）");
                        drugDisData.setClinical(doc);
                    } catch (Exception e) {
                        log.error("xiaoling error", e);
                    }
                    return true;
                }, threadPoolTaskExecutor);
                threadMap.put("clinicalEffectAsync" + drugInfo1.getId() + disease, clinicalEffectAsync);


                ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
                drugDisData.setGuide(guidelinesVos);
                CompletableFuture<Boolean> guideResult = CompletableFuture.supplyAsync(() -> {
                    long l = System.currentTimeMillis();
                    try {
                        List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, drugInfo1.getDrugZh(), diseases, s);
                        if (CollUtil.isNotEmpty(guideVOList)) {
                            for (GuideVO guideVO : guideVOList) {
                                GuidelinesVo guidelinesVo = new GuidelinesVo();
                                guidelinesVo.setContent(guideVO.getPdf_txt());
                                guidelinesVo.setZdz(guideVO.getZdz());
                                guidelinesVo.setTitle(guideVO.getTitle());
                                guidelinesVo.setFdaDate(guideVO.getFbdate());
                                guidelinesVo.setType("1");
                                guidelinesVo.setId(guideVO.getId());
                                guidelinesVo.setIsPaper(guideVO.getIsPaper());
                                guidelinesVo.setShowField(guideVO.getTitle() + "-" + guideVO.getZdz() + "-" + guideVO.getFbdate());
                                guidelinesVos.add(guidelinesVo);
                            }

                        }
                    } catch (Exception e) {
                        log.error("xiaoling error", e);
                    }
                    long k = System.currentTimeMillis();
                    System.out.println("********************************************耗时1：" + (k - l));
                    return true;
                }, gptAnalysisThreadPool);


                ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
                drugDisData.setLiterature(guidelinesVos1);
                CompletableFuture<Boolean> literatureResult = CompletableFuture.supplyAsync(() -> {
                    long l2 = System.currentTimeMillis();
                    //      List<Literature> literatureList = lxGptService.queryLiterature(drugInfo1.getDrugZh(), drugNames, s, diseases);
                    List<Literature> literatureList = null;
                    if (CollUtil.isNotEmpty(literatureList)) {
                        for (Literature literature : literatureList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(literature.getTitleQuestion());
                            guidelinesVo.setZdz(literature.getJournal());
                            guidelinesVo.setTitle(literature.getTitle());
                            guidelinesVo.setFdaDate(literature.getYear());
                            guidelinesVo.setType("2");
                            guidelinesVo.setId(literature.getId());
                            guidelinesVo.setIsPaper(0);
                            guidelinesVo.setAuthor(literature.getAuthor());
                            guidelinesVo.setShowField(literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear());
                            // 中文文献分区
                            List<String> partition = new ArrayList<>();
                            if ("zh".equals(literature.getLanguage())) {
                                List<String> recognizedKernelJournals = literature.getJournalDivision();
                                if (CollUtil.isNotEmpty(recognizedKernelJournals)) {
                                    for (String recognizedKernelJournal : recognizedKernelJournals) {
                                        switch (recognizedKernelJournal) {
                                            case "Technology":
                                                partition.add("科技核心");
                                                break;
                                            case "Peking University":
                                                partition.add("北大核心");
                                                break;
                                            case "Nanjing University":
                                                partition.add("南大核心");
                                                break;
                                            case "CSCD":
                                                partition.add("CSCD");
                                                break;
                                            default:
                                                break;
                                        }
                                    }
                                }
                            }
                            guidelinesVos1.add(guidelinesVo);
                        }
                        drugDisData.setLiterature(guidelinesVos1);
                    }
                    long k3 = System.currentTimeMillis();
                    System.out.println("********************************************耗时2：" + (k3 - l2));
                    return true;
                }, gptAnalysisThreadPool);

                threadMap.put("guideResult" + drugId + disease, guideResult);
                threadMap.put("literatureResult" + drugId, literatureResult);

                drugDisDatas.add(drugDisData);
            }

            DataVo1<OtherVo> otherVoDataVo = new DataVo1<>(drugNameDetail, drugInfo1.getId(), new OtherVo());

            OtherVo otherVo = new OtherVo();
            otherVoDataVo.setData(otherVo);

            CompletableFuture<Boolean> submit = CompletableFuture.supplyAsync(() -> {
                String query = "请根据知识库分析" + drugInfo1.getManufacturer() + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况";
                String query1 = "请根据药品注册信息、药品评审中信、国家药品监督管理局等官方网站， 以及知识库，分析" + drugInfo1.getDrugName() + "在中国、美国、欧洲、日本四国的上市/获批情况，是否在国内及国外均有销售";
                try {
                    String manufacturer = xiaoling(drugInfo1.getManufacturer(), query);
                    manufacturerMap.put(drugId, manufacturer);

                } catch (Exception e) {
                    log.error("xiaoling error", e);
                }

                try {
                    String globalUsage = xiaoling(drugInfo1.getDrugName(), query1);
                    globalUsageMap.put(drugId, globalUsage);
                } catch (Exception e) {
                    log.error("xiaoling error", e);
                }

                return true;
            }, gptAnalysisThreadPool);
            threadMap.put("submit" + drugId, submit);
        }

        long endTime = System.currentTimeMillis();
        System.out.println("********************************************总耗时：" + (endTime - startTime));
        CompletableFuture.allOf(threadMap.values().toArray(new CompletableFuture[threadMap.size()]))
                .exceptionally(ex -> {
                    log.error("子线程处理过程中出现异常: {}", ex.getMessage(), ex);
                    return null;
                }).join();
        globalUsageMap.forEach((drugId, globalUsage) -> {
            for (DrugDisData drugDisData : drugDisDatas) {
                if (drugId.equals(drugDisData.getDrugId())) {
                    drugDisData.setGlobalUsage(globalUsage);
                }
            }
        });
        manufacturerMap.forEach((drugId, manufacturer) -> {
            for (DrugDisData drugDisData : drugDisDatas) {
                if (drugId.equals(drugDisData.getDrugId())) {
                    drugDisData.setManufacturers(manufacturer);
                }
            }
        });

        return drugDisDatas;
    }


    @Override
    public List<DrugDisData> getDataTalPuls(String disease, String searchId, String drugIds) {
        // 中间有效性部分
        // 最后的其他内容
        // 指南list

        ArrayList<DrugDisData> drugDisDatas = new ArrayList<>();
        String[] ids = drugIds.split(",");

        HashMap<String, CompletableFuture<Boolean>> threadMap = new HashMap<>();

        HashMap<String, String> indicationMap = new HashMap<>();


        long startTime = System.currentTimeMillis();
        for (String drugId : ids) {
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            if (ObjectUtil.isEmpty(drugInfo1)) {
                throw new RuntimeException("未找到药品信息");
            }


            String register = drugInfo1.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }

                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo1.setPdf(approveCode.getPdf());
                    }
                }
            }

            String isAdverseReactions = "0";
            // 合理用药
            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh()) || ObjectUtil.isNotEmpty(drugInfo1.getDrugSynonymZh())) {
                JSONObject evaluationMedicine = getHeliYongYao(drugInfo1.getDrugZh());
                if (ObjectUtil.isEmpty(evaluationMedicine)) {
                    List<JSONObject> evaluationMedicines = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugInfo1.getDrugSynonymZh())), JSONObject.class, CommonConstants.REASONABLE_DRUG_TABLE_NAME);
                    if (CollUtil.isNotEmpty(evaluationMedicines)) {
                        evaluationMedicine = evaluationMedicines.get(0);
                    }
                }
                if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                        drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                        drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));
                        isAdverseReactions = "1";
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                    }

                    if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                            (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                    CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                        drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                        drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                        drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                    }


                }
            }

            DrugAddDto drugAdd = null;
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }
            if (StringUtils.isEmpty(drugInfo1.getPharmacology())) {

                try {
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的药理作用是什么", "药理作用");
                    drugInfo1.setPharmacology(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

            }
            if (StringUtils.isEmpty(drugInfo1.getPharmacokinetics())) {

                try {
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的药代动力学是什么", "药代动力学");
                    drugInfo1.setPharmacokinetics(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

            }


            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            InstructionDataVo instructionDataVo;
            if ((StringUtils.isEmpty(drugInfo1.getAdverseReaction()) && StringUtils.isEmpty(drugInfo1.getCommonAdverseReactions()))
                    && StringUtils.isEmpty(drugInfo1.getSeriousAdverseRactions())) {
                String s1;
                String s2;
                try {
                    s1 = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的常见不良反应是什么，以及概率", "常见不良反应，以及概率");
                    s2 = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的严重不良反应是什么，以及概率", "常见不良反应，以及概率");
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

                instructionDataVo = new InstructionDataVo(drugInfo1.getPharmacology(),
                        drugInfo1.getPharmacokinetics(), drugInfo1.getAdverseReaction(), s1,
                        s2, getInstructionUrl(drugInfo1), drugNameDetail, "1");

            } else {
                instructionDataVo = new InstructionDataVo(drugInfo1.getPharmacology(),
                        drugInfo1.getPharmacokinetics(), drugInfo1.getAdverseReaction(), drugInfo1.getCommonAdverseReactions(),
                        drugInfo1.getSeriousAdverseRactions(), getInstructionUrl(drugInfo1), drugNameDetail, isAdverseReactions);
            }


            // 修改有一个不存在
            if (StringUtils.isNotEmpty(drugInfo1.getCommonAdverseReactions()) && StringUtils.isEmpty(drugInfo1.getSeriousAdverseRactions())) {
                try {
                    String s2 = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的严重不良反应是什么，以及概率", "常见不良反应，以及概率");
                    instructionDataVo.setSeriousAdverseReactions(s2);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
            if (StringUtils.isNotEmpty(drugInfo1.getSeriousAdverseRactions()) && StringUtils.isEmpty(drugInfo1.getCommonAdverseReactions())) {
                try {
                    String s1 = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的常见不良反应是什么，以及概率", "常见不良反应，以及概率");
                    instructionDataVo.setCommonAdverseReactions(s1);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            // 同义词
            ArrayList<String> drugNames = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugNames, drugInfo1);
            String[] split = disease.split(";");

            for (String s : split) {
                String disease1 = s;
                DrugDisData drugDisData = new DrugDisData();
                drugDisData.setDrugId(drugInfo1.getId());
                drugDisData.setDisease(s);
                drugDisData.setTitle(drugNameDetail + " 用于 " + s);
                drugDisData.setInfo(instructionDataVo);
                ArrayList<String> diseases = new ArrayList<>();
                GetSynonymsDisease(s, diseases);
                indicationMap.put(drugInfo1.getDrugName() + s + "in", "请分析一下在临床研究中，在治疗" + s + "的药品除了" + drugInfo1.getDrugName() + "还有哪些？判断临床上" + drugInfo1.getDrugName() + "治疗" + s + "时，属于临床必需首选药品，或者是临床必需次选药品，还是可选药品较多？");
                indicationMap.put(drugInfo1.getDrugName() + s + "cl", "假设你现在是个临床试验研究员，请基于临床试验或者国内外文献，简述" + drugInfo1.getDrugName() + "治疗" + s + "临床疗效方面，" +
                        "经常以哪些结局指标作为观察疗效的指标" +
                        "并分别简述不同结局指标下试验组与对照组的情况，经常以哪些结局指标作为观察疗效的指标（需要分别阐述主要疗效指标与次要疗效指标），并分别简述这些不同结局指标下试验组与对照组的情况（需要说明试验组与对照组分别包含哪些干预措施）。(回答结果需要有恰当换行(每行需要用'$$'隔开))");
                ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
                drugDisData.setGuide(guidelinesVos);
                DrugInfoNew finalDrugInfo = drugInfo1;
                CompletableFuture<Boolean> guideResult = CompletableFuture.supplyAsync(() -> {
                    long l = System.currentTimeMillis();
                    try {
                        List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, finalDrugInfo.getDrugZh(), diseases, s);
                        if (CollUtil.isNotEmpty(guideVOList)) {
                            for (GuideVO guideVO : guideVOList) {
                                GuidelinesVo guidelinesVo = new GuidelinesVo();
                                guidelinesVo.setContent(guideVO.getPdf_txt());
                                guidelinesVo.setZdz(guideVO.getZdz());
                                guidelinesVo.setTitle(guideVO.getTitle());
                                guidelinesVo.setFdaDate(guideVO.getFbdate());
                                guidelinesVo.setType("1");
                                guidelinesVo.setId(guideVO.getId());
                                guidelinesVo.setIsPaper(guideVO.getIsPaper());
                                guidelinesVo.setShowField(guideVO.getTitle() + "-" + guideVO.getZdz() + "-" + guideVO.getFbdate());
                                guidelinesVos.add(guidelinesVo);
                            }

                        }
                    } catch (Exception e) {
                        log.error("xiaoling error", e);
                    }
                    long k = System.currentTimeMillis();
                    System.out.println("********************************************耗时1：" + (k - l));
                    return true;
                }, gptAnalysisThreadPool);


                ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
                drugDisData.setLiterature(guidelinesVos1);
                CompletableFuture<Boolean> literatureResult = CompletableFuture.supplyAsync(() -> {
                    long l2 = System.currentTimeMillis();
//                     List<Literature> literatureList = lxGptService.queryLiterature(drugInfo1.getDrugZh(), drugNames, s, diseases);
                    List<Literature> literatureList = null;
                    if (CollUtil.isNotEmpty(literatureList)) {
                        for (Literature literature : literatureList) {
                            GuidelinesVo guidelinesVo = new GuidelinesVo();
                            guidelinesVo.setContent(literature.getTitleQuestion());
                            guidelinesVo.setZdz(literature.getJournal());
                            guidelinesVo.setTitle(literature.getTitle());
                            guidelinesVo.setFdaDate(literature.getYear());
                            guidelinesVo.setType("2");
                            guidelinesVo.setId(literature.getId());
                            guidelinesVo.setIsPaper(0);
                            guidelinesVo.setAuthor(literature.getAuthor());
                            guidelinesVo.setShowField(literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear());
                            // 中文文献分区
                            List<String> partition = new ArrayList<>();
                            if ("zh".equals(literature.getLanguage())) {
                                List<String> recognizedKernelJournals = literature.getJournalDivision();
                                if (CollUtil.isNotEmpty(recognizedKernelJournals)) {
                                    for (String recognizedKernelJournal : recognizedKernelJournals) {
                                        switch (recognizedKernelJournal) {
                                            case "Technology":
                                                partition.add("科技核心");
                                                break;
                                            case "Peking University":
                                                partition.add("北大核心");
                                                break;
                                            case "Nanjing University":
                                                partition.add("南大核心");
                                                break;
                                            case "CSCD":
                                                partition.add("CSCD");
                                                break;
                                            default:
                                                break;
                                        }
                                    }
                                }
                            }
                            guidelinesVos1.add(guidelinesVo);
                        }
                        drugDisData.setLiterature(guidelinesVos1);
                    }
                    long k3 = System.currentTimeMillis();
                    System.out.println("********************************************耗时2：" + (k3 - l2));
                    return true;
                }, gptAnalysisThreadPool);

                threadMap.put("guideResult" + drugId + disease, guideResult);
                threadMap.put("literatureResult" + drugId, literatureResult);
                drugDisData.setDrugName(drugInfo1.getDrugName());
                drugDisData.setDrugZh(drugInfo1.getDrugZh());
                drugDisData.setDisease(s);
                drugDisData.setManufacturer(drugInfo1.getManufacturer());
                drugDisDatas.add(drugDisData);
            }

            DataVo1<OtherVo> otherVoDataVo = new DataVo1<>(drugNameDetail, drugInfo1.getId(), new OtherVo());

            OtherVo otherVo = new OtherVo();
            otherVoDataVo.setData(otherVo);
//            String query = "请根据知识库分析" + drugInfo1.getManufacturer() + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况";
            String query1 = "请根据药品注册信息、药品评审中信、国家药品监督管理局等官方网站， 以及知识库，分析" + drugInfo1.getDrugName() + "在中国、美国、欧洲、日本四国的上市/获批情况，是否在国内及国外均有销售";
//            indicationMap.put(drugInfo1.getManufacturer() + "ma", query);
            indicationMap.put(drugInfo1.getDrugName() + "gl", query1);


        }

        HashMap<String, String> Mapx = new HashMap<>();
        AtomicInteger x = new AtomicInteger(1);
        HashMap<String, String> promptR = new HashMap<>();
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性）：\n");
        indicationMap.forEach((k, v) -> {
            String key = "问题" + x;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
            stringBuilder.append(prompt);
            String title = "question" + x;
            promptR.put(title, "###" + key + "###的答案(回答需要带格式（分行显示，每行用换行符隔开）)");
            Mapx.put(k, title);
            x.incrementAndGet();

        });
        JSONObject responseFormat = getResponseFormat(promptR);


        // 创建子线程执行
        CompletableFuture<Boolean> total = CompletableFuture.supplyAsync(() -> {
            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder.toString(), "检索所有项目", responseFormat, "", "");
            log.info(jsonObject.toJSONString());
            for (DrugDisData drugDisData : drugDisDatas) {
                try {
//                    String maKey = drugDisData.getManufacturer() + "ma";
//                    String ma = Mapx.get(maKey);
//                    if (ma != null) {
//                        String s = jsonObject.getString(ma).replaceAll("\\$\\$", "\n");
//                        drugDisData.setManufacturers(s);
//                    } else {
//                        drugDisData.setManufacturers("暂无");
//                    }
                    String que = drugDisData.getManufacturer() + "企业在制药企业和工信部医药工业百强榜企业中的排名情况";
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(que, que);
                    drugDisData.setManufacturers(s);
                } catch (Exception e) {
                    drugDisData.setManufacturers("暂无");
                    e.printStackTrace();
                }


                try {
                    String inKey = drugDisData.getDrugName() + drugDisData.getDisease() + "in";
                    String in = Mapx.get(inKey);
                    if (in != null) {
                        String s = jsonObject.getString(in).replaceAll("\\$\\$", "\n");
                        drugDisData.setIndication(s);
                    } else {
                        drugDisData.setIndication("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setIndication("暂无");
                    e.printStackTrace();
                }

                try {
                    String clKey = drugDisData.getDrugName() + drugDisData.getDisease() + "cl";
                    String cl = Mapx.get(clKey);
                    if (cl != null) {
                        String s = jsonObject.getString(cl).replaceAll("\\$\\$", "\n");
                        drugDisData.setClinical(s);
                    } else {
                        drugDisData.setClinical("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setClinical("暂无");
                    e.printStackTrace();
                }


                try {
                    String glKey = drugDisData.getDrugName() + "gl";
                    String gl = Mapx.get(glKey);
                    if (gl != null) {
                        String s = jsonObject.getString(gl).replaceAll("\\$\\$", "\n");
                        drugDisData.setGlobalUsage(s);
                    } else {
                        drugDisData.setGlobalUsage("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setGlobalUsage("暂无");
                    e.printStackTrace();
                }
                if (CollUtil.isNotEmpty(drugDisData.getGuide())) {
                    drugDisData.setLiterature(new ArrayList<>());
                }
            }

            return true;
        }, guideAnalysisThreadPool);

        threadMap.put("total", total);

        long endTime = System.currentTimeMillis();
        System.out.println("********************************************总耗时：" + (endTime - startTime));
        CompletableFuture.allOf(threadMap.values().toArray(new CompletableFuture[threadMap.size()]))
                .exceptionally(ex -> {
                    log.error("子线程处理过程中出现异常: {}", ex.getMessage(), ex);
                    return null;
                }).join();


        return drugDisDatas;
    }

    private JSONObject getResponseFormat(Map<String, String> format) {
        JSONObject responseFormat = new JSONObject();
        JSONObject json_schema = new JSONObject();
        JSONObject schema = new JSONObject();
        JSONObject properties = new JSONObject();
        responseFormat.put("type", "json_schema");   // gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  // gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   // gpt未说明   固定
        json_schema.put("strict", true);  // 开启固定格式

        schema.put("additionalProperties", false);
        ArrayList<String> strings = new ArrayList<>();// 此对象包含的字段
        format.forEach((k, v) -> {                  // 组装此对象的所有字段
            JSONObject propertie = new JSONObject();
            propertie.put("type", "string");   // 这里默认认为字符串类型
            propertie.put("description", v);   // 此字段的描述
            properties.put(k, propertie);   // 此字段作为json的key，对应值为
            strings.add(k);
        });
        schema.put("properties", properties);
        schema.put("required", strings);  // 此对象包含的字段
        schema.put("type", "object");
        json_schema.put("schema", schema);
        return responseFormat;

    }


    private GuidelinesVo convertToGuidelinesVo(GuideVO guideVO) {
        GuidelinesVo guidelinesVo = new GuidelinesVo();
        guidelinesVo.setContent(guideVO.getPdf_txt());
        guidelinesVo.setZdz(guideVO.getZdz());
        guidelinesVo.setTitle(guideVO.getTitle());
        guidelinesVo.setFdaDate(guideVO.getFbdate());
        guidelinesVo.setType("1");
        guidelinesVo.setId(guideVO.getId());
        guidelinesVo.setIsPaper(guideVO.getIsPaper());
        return guidelinesVo;
    }

    private GuidelinesVo convertToGuidelinesVo(Literature literature) {
        GuidelinesVo guidelinesVo = new GuidelinesVo();
        guidelinesVo.setContent(literature.getTitleQuestion());
        guidelinesVo.setZdz(literature.getJournal());
        guidelinesVo.setTitle(literature.getTitle());
        guidelinesVo.setFdaDate(literature.getYear());
        guidelinesVo.setType("2");
        guidelinesVo.setId(literature.getId());
        guidelinesVo.setIsPaper(0);
        guidelinesVo.setAuthor(literature.getAuthor());
        return guidelinesVo;
    }


    private String xiaoling(String search, String prompt) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("prompt", prompt + "(中文一句话返回)");
        jsonObject.put("word", search);
        String s = "";
        try {
            s = medicineFeign.gptForPharmacy(jsonObject);
            if (StringUtils.isEmpty(s)) {
                throw new Exception("小灵返回为空");
            }
        } catch (Exception e) {
            log.error("小灵异常", e);
            s = youyideyiOld("请检索" + search + "的相关信息，解答以下问题" + prompt);
        }
        log.info("小灵返回{}", s);
        return s.replaceAll("\n", "");
    }

    private String youyideyiOld(String msg) {
        long ts = System.currentTimeMillis();
        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("prompt", HtmlUtil.cleanHtmlTag(msg));
        //["gpt-3.5-turbo","gpt-4-0613"]
//        jsonObject1.put("model", "gpt-4-0613");  // 112068
//        jsonObject1.put("model", "gpt-3.5-turbo");  // 慢  105605
        //      jsonObject1.put("model", "gpt-4");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-3.5-turbo-16k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
//        jsonObject1.put("model", "gpt-4-32k");  //调不通   异常 //cn.hutool.http.HttpException: Read timed out
        jsonObject1.put("model", "gpt-4o-mini");
        String response = null;
        try {
            // 将 jsonObject1 转换为字符串


            Retryer retryer = GuavaRetryer.createRetryer();
            response = (String) retryer.call(() -> {
                return gptUtil.generation(jsonObject1);
            });

            String requestBody = jsonObject1.toJSONString();
            int length = response.length();
            int length1 = response.getBytes("UTF-8").length;

            // 计算请求的字节数和字符数
            int requestCharCount = requestBody.length() + length;
            int requestByteCount = requestBody.getBytes("UTF-8").length + length1;

            // 打印请求的字节数和字符数
            System.out.println("Request Character Count: " + requestCharCount);
            System.out.println("Request Byte Count: " + requestByteCount);
            String o = (String) redisTemplate.opsForValue().get("GPT_len:" + "gpt-4o-mini");
            if (StringUtils.isNotEmpty(o)) {
                long l = Long.parseLong(o);
                l += requestByteCount;
                redisTemplate.opsForValue().set("GPT_len:" + "gpt-4o-mini", l + "");
            } else {
                redisTemplate.opsForValue().set("GPT_len:" + "gpt-4o-mini", requestByteCount + "");
            }
            String o1 = (String) redisTemplate.opsForValue().get("GPT_bt:" + "gpt-4o-mini");
            if (StringUtils.isNotEmpty(o1)) {
                long l = Long.parseLong(o1);
                l += requestByteCount;
                redisTemplate.opsForValue().set("GPT_bt:" + "gpt-4o-mini", l + "");
            } else {
                redisTemplate.opsForValue().set("GPT_bt:" + "gpt-4o-mini", requestByteCount + "");
            }

        } catch (Exception e) {
            log.error(e.getMessage() + "*********gpt调用失败*************prompt:" + msg, e);
        }
//        log.info(response.body());
        log.info("call gpt cost time:{}", System.currentTimeMillis() - ts);
        if (StringUtils.isNotEmpty(response)) {
            response = response.replaceAll("\\uFFFD", "");
            response = response.replaceAll("\\\\n", "");
            response = response.replaceAll("#", "");
            return response.replaceAll("[\r\n]", "");
        }
        return "";
    }

    private String getInstructionUrl(DrugInfoNew drugInfo) {

        if (StringUtils.isNotBlank(drugInfo.getPdf())) {
            return "https://image.evimed.com/pmc/instruction_for_select/" + drugInfo.getPdf();
//        } else {
//            //开始查询是否有说明书
//            BoolQueryBuilder boolQueryBuilderInstructions = QueryBuilders.boolQuery();
//            //药品名称判定-中文
//            BoolQueryBuilder boolQueryBuilderName = QueryBuilders.boolQuery();
//
//            MultiMatchQueryBuilder multiMatchQueryBuilderZh = QueryBuilders.multiMatchQuery(drugInfo.getDrugName().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//            multiMatchQueryBuilderZh.operator(Operator.AND);
//            boolQueryBuilderName.should().add(multiMatchQueryBuilderZh);
//            if (StringUtils.isNotBlank(drugInfo.getDrugEn())) {
//                //药品名称判定-英文
//                MultiMatchQueryBuilder multiMatchQueryBuilderEn = QueryBuilders.multiMatchQuery(drugInfo.getDrugEn().replaceAll("<span>", "").replaceAll("</span>", ""), "genericNames", "englishName", "tradeNames");
//                multiMatchQueryBuilderEn.operator(Operator.AND);
//                boolQueryBuilderName.should().add(multiMatchQueryBuilderEn);
//            }
//            boolQueryBuilderInstructions.must().add(boolQueryBuilderName);
//
//            if (StringUtils.isNotBlank(drugInfo.getManufacturer())) {
//                //厂家判定
//                MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("enterpriseName", drugInfo.getManufacturer().replaceAll("<span>", "").replaceAll("</span>", ""));
//                matchQueryBuilder.operator(Operator.AND);
//                boolQueryBuilderInstructions.must().add(matchQueryBuilder);
//            }
//
//            boolQueryBuilderInstructions.must().add(QueryBuilders.existsQuery("source"));
//            NativeSearchQuery nativeSearchQueryInstructions = new NativeSearchQuery(boolQueryBuilderInstructions);
//            nativeSearchQueryInstructions.setPageable(PageRequest.of(0, 1));
//            SearchHits<org.springframework.data.elasticsearch.core.document.Document> searchHits = elasticsearchRestTemplate.search(nativeSearchQueryInstructions, org.springframework.data.elasticsearch.core.document.Document.class, IndexCoordinates.of("instruction_data_index"));
//            List<String> listx = new ArrayList<>(Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药"));
//            for (SearchHit<org.springframework.data.elasticsearch.core.document.Document> searchHit : searchHits) {
//                org.springframework.data.elasticsearch.core.document.Document contentInstructions = searchHit.getContent();
//                String pdfName = contentInstructions.getString("pdf_name");
//                String source = contentInstructions.getString("source");
//                if (!"nmpa".equals(source)) {
//                    continue;
//                }
//                if (listx.contains(source)) {
//                    source = "nmpa";
//                }
//                if (StringUtils.isEmpty(pdfName)) {
//                    continue;
//                }
//
//                if (StringUtils.isEmpty(source)) {
//                    continue;
//                }
//                String url = "https://image.evimed.com/instructions/" + source + "/" + pdfName;
//                return url;
//            }
        }
        return "";
    }

    private void GetSynonymsDrugName(String drugName, List<String> drugs, DrugInfoNew drugInfoNew) {
        long startTime = System.currentTimeMillis();
        drugs.add(drugName);
        Map<String, String> drugTransMap = new HashMap<>();
//        drugTransMap.put(drugName, lxGptService.getTransDeepl(drugName));
//        List<DrugInfoNew> drugInfos = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugs)), DrugInfoNew.class);
        List<String> drugsCopy = new ArrayList<>();

        if (StrUtil.isNotBlank(drugInfoNew.getDrugEn())) {
            drugsCopy.add(drugInfoNew.getDrugEn());
        }
        if (StrUtil.isNotBlank(drugInfoNew.getDrugZh())) {
            drugsCopy.add(drugInfoNew.getDrugZh());
        }
        if (CollUtil.isNotEmpty(drugInfoNew.getDrugSynonymEn())) {
            drugsCopy.addAll(drugInfoNew.getDrugSynonymEn());
        }
        if (CollUtil.isNotEmpty(drugInfoNew.getDrugSynonymZh())) {
            drugsCopy.addAll(drugInfoNew.getDrugSynonymZh());
        }
        ;
        drugs.addAll(drugsCopy.stream().distinct().collect(Collectors.toList()));
        // 获取完同义词
        boolean isUseTransDrug = GetSynonymUtil.getSynonym(drugName, drugs, drugs);
//        if (!isUseTransDrug) {
//            //翻译词的同义词
//            if (StrUtil.isNotBlank(drugTransMap.get(drugName))) {
//                drugs.add(drugTransMap.get(drugName));
//                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(drugTransMap.get(drugName));
//                drugs.addAll(synonymTrans);
//            }
//        }
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        long endTime = System.currentTimeMillis();
        log.info("#############################获取药品同义词时间{}#########################", endTime - startTime);
    }


    private void GetSynonymsDisease(String disease, List<String> diseases) {
        long startTime = System.currentTimeMillis();
        diseases.add(disease);
//        String defaultPrompt = CommonPromptEnum.DISEASE_SPLIT.getDefaultPrompt();
//        String gpt = lxGptService.getGpt(defaultPrompt + disease, null);
//        diseases.add(gpt);


        Map<String, String> diseaseTransMap = new HashMap<>();
//        diseaseTransMap.put(disease, lxGptService.getTransDeepl(disease));
        // 获取完同义词
        boolean isUseTransDisease = GetSynonymUtil.getSynonym(disease, diseases, diseases);
//        if (!isUseTransDisease) {
//            //翻译词的同义词
//            if (StrUtil.isNotBlank(diseaseTransMap.get(disease))) {
//                diseases.add(diseaseTransMap.get(disease));
//                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(diseaseTransMap.get(disease));
//                diseases.addAll(synonymTrans);
//            }
//        }
        Pattern pattern = Pattern.compile("^" + Pattern.quote(disease) + "$", Pattern.CASE_INSENSITIVE);
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("disease_name_chinese").regex(pattern)), JSONObject.class, "disease_abbreviation");
        if (CollUtil.isNotEmpty(jsonObjects)) {
            String string = jsonObjects.get(0).getString("abbreviation_english_name_of_the_disease");
            if (StrUtil.isNotEmpty(string)) {
                if (!diseases.contains(string)) {
                    diseases.add(string);
                }
            }
        }
        diseases = diseases.stream().distinct().collect(Collectors.toList());
        long endTime = System.currentTimeMillis();
        log.info("#############################获取疾病同义词时间{}#########################", endTime - startTime);
    }

    private void GetSynonyms(String drugName, List<String> drugs, String disease, List<String> diseases) {
        drugs.add(drugName);
        diseases.add(disease);
        Map<String, String> drugTransMap = new HashMap<>();
        drugTransMap.put(drugName, lxGptService.getTransDeepl(drugName));
        List<DrugInfoNew> drugInfos = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugs)), DrugInfoNew.class);
        List<String> drugsCopy = new ArrayList<>();
        drugInfos.forEach(DrugInfoNew -> {
            if (StrUtil.isNotBlank(DrugInfoNew.getDrugEn())) {
                drugsCopy.add(DrugInfoNew.getDrugEn());
            }
            if (StrUtil.isNotBlank(DrugInfoNew.getDrugZh())) {
                drugsCopy.add(DrugInfoNew.getDrugZh());
            }
            if (CollUtil.isNotEmpty(DrugInfoNew.getDrugSynonymEn())) {
                drugsCopy.addAll(DrugInfoNew.getDrugSynonymEn());
            }
            if (CollUtil.isNotEmpty(DrugInfoNew.getDrugSynonymZh())) {
                drugsCopy.addAll(DrugInfoNew.getDrugSynonymZh());
            }
        });
        drugs.addAll(drugsCopy.stream().distinct().collect(Collectors.toList()));
        // 获取完同义词
        boolean isUseTransDrug = GetSynonymUtil.getSynonym(drugName, drugs, drugs);
        if (!isUseTransDrug) {
            // 翻译词的同义词
            if (StrUtil.isNotBlank(drugTransMap.get(drugName))) {
                drugs.add(drugTransMap.get(drugName));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(drugTransMap.get(drugName));
                drugs.addAll(synonymTrans);
            }
        }
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        Map<String, String> diseaseTransMap = new HashMap<>();
        diseaseTransMap.put(disease, lxGptService.getTransDeepl(disease));
        // 获取完同义词
        boolean isUseTransDisease = GetSynonymUtil.getSynonym(disease, diseases, diseases);
        if (!isUseTransDisease) {
            // 翻译词的同义词
            if (StrUtil.isNotBlank(diseaseTransMap.get(disease))) {
                diseases.add(diseaseTransMap.get(disease));
                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(diseaseTransMap.get(disease));
                diseases.addAll(synonymTrans);
            }
        }
        diseases = diseases.stream().distinct().collect(Collectors.toList());
    }

    private void getDrugInfoMap(DrugInfoNew drugInfoNew, Instructions instructionsDeduplicated1, DrugAndIndicationIndex DrugAndIndicationIndex) {
        instructionsDeduplicated1.setId(instructionsDeduplicated1.getId());
        drugInfoNew.setId(instructionsDeduplicated1.getId());
        DrugAndIndicationIndex.setId(instructionsDeduplicated1.getId());
        // 药品名称
        String drugName = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getDrugName2());
        drugInfoNew.setDrugName(drugName);
        DrugAndIndicationIndex.setZhDrugName(drugName);
        // 剂型
        String dosageForm = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getDosageForm2());
        drugInfoNew.setDosageForm(dosageForm);
        DrugAndIndicationIndex.setDosageForm(dosageForm);
        // 药品厂家
        String manufacturer = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getManufacturer2());
        drugInfoNew.setManufacturer(manufacturer);
        DrugAndIndicationIndex.setManufacturer(manufacturer);
        // 国药准字
        String register = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getApprovalNumber2());
        drugInfoNew.setRegister(register);
        DrugAndIndicationIndex.setRegister(register);
        // 单方制剂
        // 药品规格
        String specifications = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getSpecifications2());
        drugInfoNew.setSpecifications(specifications);
        DrugAndIndicationIndex.setSpecifications(specifications);
        // 商品名
        String commodityNameZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getProductNameZh2());
        drugInfoNew.setCommunityNameZh(commodityNameZh);
        DrugAndIndicationIndex.setCommodityNameZh(commodityNameZh);
        String commodityNameEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getProductNameEn2());
        drugInfoNew.setCommunityNameEn(commodityNameEn);
        DrugAndIndicationIndex.setCommodityNameEn(commodityNameEn);
        // 一到四级中英文
        String oneNameZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFirstLevelChinese());
        drugInfoNew.setOneNameZh(oneNameZh);
        String oneNameEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFirstLevelEnglish());
        drugInfoNew.setOneNameEn(oneNameEn);

        String twoNameZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getSecondLevelChinese());
        drugInfoNew.setTwoNameZh(twoNameZh);
        String twoNameEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getSecondLevelEnglish());
        drugInfoNew.setTwoNameEn(twoNameEn);

        String threeNameZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getThirdLevelChinese());
        drugInfoNew.setThreeNameZh(threeNameZh);
        String threeNameEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getThirdLevelEnglish());
        drugInfoNew.setThreeNameEn(threeNameEn);

        String fourNameZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFourthLevelChinese());
        drugInfoNew.setFourNameZh(fourNameZh);
        String fourNameEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFourthLevelEnglish());
        drugInfoNew.setFourNameEn(fourNameEn);
        // 五级编码
        String fiveCoding = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFifthLevelCode());
        drugInfoNew.setFiveCoding(fiveCoding);
        // 药品名称
        String drugEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFifthLevelEnglish());
        drugInfoNew.setDrugEn(drugEn);
        String drugZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFifthLevelChinese());
        drugInfoNew.setDrugZh(drugZh);
        DrugAndIndicationIndex.setDrugEn(drugEn);
        DrugAndIndicationIndex.setDrugZh(drugZh);
        // 药品同义词
        String drugSynonymZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFifthLevelChineseSynonyms());
        drugInfoNew.setDrugSynonymZh(Arrays.asList(drugSynonymZh.split("(;|；)")));
        String drugSynonymEn = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getFifthLevelEnglishSynonyms());
        drugInfoNew.setDrugSynonymEn(Arrays.asList(drugSynonymEn.split("卍")));
        //
        List<String> drugNames = new ArrayList<>();
        List<String> zhDrugNames = new ArrayList<>();
        List<String> enDrugNames = new ArrayList<>();
        // 检索字段
        drugNames.add(drugName.toLowerCase());
        drugNames.add(drugZh.toLowerCase());
        drugNames.add(drugEn.toLowerCase());
        drugNames.add(commodityNameEn.toLowerCase());
        drugNames.add(commodityNameZh.toLowerCase());
        for (String drugSynonyman : drugInfoNew.getDrugSynonymEn()) {
            drugNames.add(drugSynonyman.toLowerCase());
            enDrugNames.add(drugSynonyman.toLowerCase());
        }
        for (String drugSynonyman : drugInfoNew.getDrugSynonymZh()) {
            drugNames.add(drugSynonyman.toLowerCase());
            zhDrugNames.add(drugSynonyman.toLowerCase());
        }
        zhDrugNames.add(drugZh.toLowerCase());
        enDrugNames.add(drugEn.toLowerCase());
        DrugAndIndicationIndex.setZhDrugNames(zhDrugNames);
        DrugAndIndicationIndex.setEnDrugNames(enDrugNames);

        DrugAndIndicationIndex.setDrugName(drugNames);

        // 医保情况
        String medicalInsurance = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getClassAB());
        drugInfoNew.setMedicalInsurance(medicalInsurance);
        DrugAndIndicationIndex.setMedicalInsurance(medicalInsurance);

        // 支付范围
        String paymentScope = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsPaymentRestriction());
        drugInfoNew.setPaymentScope(paymentScope);

        // 国家基药
        String essentialMedicines = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsBasicMedicine());
        drugInfoNew.setEssentialMedicines(essentialMedicines);

        // 是否有△要求
        String essentialType = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsDeltaRequirement());
        drugInfoNew.setEssentialType(essentialType);

        // 适应症
        String indication = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIndicationsOriginal());
        drugInfoNew.setIndication(indication);
        DrugAndIndicationIndex.setIndication(indication);

        // 中文疾病名（适应症新）
        List<String> diseaseZh = new ArrayList<>();
        String indicationZh = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIndicationsNew());
        if (!StringUtils.isEmpty(indicationZh)) {
            diseaseZh = Arrays.asList(indicationZh.split("###"));
        }
        drugInfoNew.setDiseaseZh(diseaseZh);
        drugInfoNew.setDiseaseEn(new ArrayList<>());
        DrugAndIndicationIndex.setDiseaseZh(diseaseZh);
        DrugAndIndicationIndex.setDiseaseEn(new ArrayList<>());
        DrugAndIndicationIndex.setDisease(diseaseZh);

        // 皮试情况
        String skinTest = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsSkinTestRequired());
        drugInfoNew.setSkinTest(skinTest);

        // 集中采药情况
        String drugCollection = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsCentralizedPurchasingMedicine());
        drugInfoNew.setDrugCollection(drugCollection);


        // 其他属性
        // 原研药
        String originalDrug = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsOriginalDrug());
        drugInfoNew.setOriginalDrug(originalDrug);
        // 参比药品
        String referenceDrug = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsGenericDrugReferenceDrug());
        drugInfoNew.setReferenceDrug(referenceDrug);
        // 一致性评价药品
        String consistencyDrug = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIsConsistencyEvaluationDrug());
        drugInfoNew.setConsistencyDrug(consistencyDrug);
        // 成分
        String ingredient = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIngredient());
        drugInfoNew.setIngredient(ingredient);
        // 注意事项
        String notes = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getNotes());
        drugInfoNew.setNotes(notes);
        // 禁忌
        String taboo = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getTaboo());
        drugInfoNew.setTaboo(taboo);
        // 单位
        String unit = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getUnit());
        drugInfoNew.setUnit(unit);
        // 单位价格
        String unitPrice = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getUnitPrice());
        drugInfoNew.setUnitPrice(unitPrice);
        // 价格
        String price = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getPrice());
        drugInfoNew.setPrice(price);
        // 转换比
        String ratio = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getConversionRatio());
        drugInfoNew.setRatio(ratio);
        // 集采药品中标价格（元）
        String outbidPrice = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getCentralizedPurchasingMedicinePrice());
        drugInfoNew.setOutbidPrice(outbidPrice);
        // 包装
        String pack = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getSpecificationPackaging());
        drugInfoNew.setPack(pack);
        // 单方制剂
        String drugType = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getSingleOrCompoundPreparation());
        drugInfoNew.setDrugType(drugType);
        DrugAndIndicationIndex.setDrugType(drugType);
        // 药学特性部分
        // 药理作用 -- 药理作用
        String pharmacology = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getPharmacology());
        drugInfoNew.setPharmacology(pharmacology);
        // 药代动力学 -- 体内过程
        String pharmacokinetics = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getPharmacokinetics());
        drugInfoNew.setPharmacokinetics(pharmacokinetics);
        // 用法用量 -- 药剂学与使用方法
        String usageAndDosage = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getUsageAndDosage());
        drugInfoNew.setUsageAndDosage(usageAndDosage);
        DrugAndIndicationIndex.setUsageAndDosage(usageAndDosage);
        // 贮藏 -- 贮藏条件
        String storage = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getStorage());
        drugInfoNew.setStorage(storage);
        // 有效期 -- 有效期
        String indate = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIndate());
        drugInfoNew.setIndate(indate);
        // 主治
        String indications = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getIndications());
        drugInfoNew.setIndications(indications);
        DrugAndIndicationIndex.setIndications(indications);
        // 安全性部分
        // 不良反应
        String adverseReaction = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getAdverseReaction());
        drugInfoNew.setAdverseReaction(adverseReaction);
        DrugAndIndicationIndex.setAdverseReaction(adverseReaction);
        // 孕妇及哺乳期妇女
        String pregnantWomen = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getPregnantWomen());
        drugInfoNew.setPregnantWomen(pregnantWomen);
        // 儿童用药
        String childrenMedicine = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getChildrenMedicine());
        drugInfoNew.setChildrenMedicine(childrenMedicine);
        // 老年用药
        String geriatricMedicine = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getGeriatricMedicine());
        drugInfoNew.setGeriatricMedicine(geriatricMedicine);
        // 药物相互作用
        String drugInteraction = instructionsDeduplicated1.getTxt(instructionsDeduplicated1.getDrugInteractio());
        drugInfoNew.setDrugInteraction(drugInteraction);
        if (StringUtils.isNotEmpty(drugInteraction) || StringUtils.isNotEmpty(adverseReaction) || StringUtils.isNotEmpty(specifications)) {
            int x = 0;
            if (StringUtils.isNotEmpty(indications)) {
                x++;
            }
            if (StringUtils.isNotEmpty(adverseReaction)) {
                x++;
            }
            if (StringUtils.isNotEmpty(usageAndDosage)) {
                x++;
            }
            DrugAndIndicationIndex.setIntegrityScore(x);
        }
        // 剩余不变参数
        drugInfoNew.setMatched_images(instructionsDeduplicated1.getMatched_images());
        drugInfoNew.setUrl(instructionsDeduplicated1.getUrl());
        drugInfoNew.setSource(instructionsDeduplicated1.getSource());
//        drugInfoNew.setSpecificationsInd(instructionsDeduplicated1.getSpecifications());
//        drugInfoNew.setDosageFormInd(instructionsDeduplicated1.getDosageForm());
//        drugInfoNew.setIngredientInd(instructionsDeduplicated1.getIngredient());
//        drugInfoNew.setIndicationsInd(instructionsDeduplicated1.getIndications());
//        drugInfoNew.setUsageAndDosageInd(instructionsDeduplicated1.getUsageAndDosage());
//        drugInfoNew.setPregnantWomenInd(instructionsDeduplicated1.getPregnantWomen());
//        drugInfoNew.setGeriatricMedicineInd(instructionsDeduplicated1.getGeriatricMedicine());
//        drugInfoNew.setChildrenMedicineInd(instructionsDeduplicated1.getChildrenMedicine());
//        drugInfoNew.setAdverseReactionInd(instructionsDeduplicated1.getAdverseReaction());
//        drugInfoNew.setNotesInd(instructionsDeduplicated1.getNotes());
//        drugInfoNew.setPharmacokineticsInd(instructionsDeduplicated1.getPharmacokinetics());
//        drugInfoNew.setPharmacologyInd(instructionsDeduplicated1.getPharmacology());
//        drugInfoNew.setToxicologyInd(instructionsDeduplicated1.getToxicology());
//        drugInfoNew.setStorageInd(instructionsDeduplicated1.getStorage());
//        drugInfoNew.setPackInd(instructionsDeduplicated1.getPack());
//        drugInfoNew.setTabooInd(instructionsDeduplicated1.getTaboo());
//        drugInfoNew.setDrugInteractioInd(instructionsDeduplicated1.getDrugInteractio());
//        drugInfoNew.setCharacteristicsInd(instructionsDeduplicated1.getCharacteristics());
//        drugInfoNew.setApprovalDateInd(instructionsDeduplicated1.getApprovalDate());
//        drugInfoNew.setModifyDateInd(instructionsDeduplicated1.getModifyDate());
//        drugInfoNew.setUpdateDateInd(instructionsDeduplicated1.getUpdateDate());
//        drugInfoNew.setIndateInd(instructionsDeduplicated1.getIndate());
//        drugInfoNew.setWarningInd(instructionsDeduplicated1.getWarning());
//        drugInfoNew.setApprovalNumberInd(instructionsDeduplicated1.getApprovalNumber());
//        drugInfoNew.setOtcInd(instructionsDeduplicated1.getOtc());
//        drugInfoNew.setClinicalTrialInd(instructionsDeduplicated1.getClinicalTrial());
//        drugInfoNew.setChemicalCompositionInd(instructionsDeduplicated1.getChemicalComposition());
//        drugInfoNew.setTakingAndEatingInd(instructionsDeduplicated1.getTakingAndEating());
//        drugInfoNew.setDrugAdminClsInd(instructionsDeduplicated1.getDrugAdminCls());
//        drugInfoNew.setRetailPriceInd(instructionsDeduplicated1.getRetailPrice());
//        drugInfoNew.setDrugPictureInd(instructionsDeduplicated1.getDrugPicture());
//        drugInfoNew.setFunctionInd(instructionsDeduplicated1.getFunction());
//        drugInfoNew.setMainIngredientInd(instructionsDeduplicated1.getMainIngredient());
//        drugInfoNew.setKeyIngredientInd(instructionsDeduplicated1.getKeyIngredient());
//        drugInfoNew.setHealthFunctionInd(instructionsDeduplicated1.getHealthFunction());
//        drugInfoNew.setPinyinInd(instructionsDeduplicated1.getPinyin());
//        drugInfoNew.setProductionAddressInd(instructionsDeduplicated1.getProductionAddress());
//        drugInfoNew.setOverdoseInd(instructionsDeduplicated1.getOverdose());
//        drugInfoNew.setStandardInd(instructionsDeduplicated1.getStandard());
//        drugInfoNew.setPrecautionsInd(instructionsDeduplicated1.getPrecautions());
//        drugInfoNew.setCategoryInd(instructionsDeduplicated1.getCategory());
//        drugInfoNew.setDelegatorInd(instructionsDeduplicated1.getDelegator());
//        drugInfoNew.setImportDrugRegNumInd(instructionsDeduplicated1.getImportDrugRegNum());
//        drugInfoNew.setUsageIntroductionInd(instructionsDeduplicated1.getUsageIntroduction());
//        drugInfoNew.setAgentCompanyInd(instructionsDeduplicated1.getAgentCompany());
//        drugInfoNew.setPackagingCompanyInd(instructionsDeduplicated1.getPackagingCompany());
//        drugInfoNew.setPregnancyGradeInd(instructionsDeduplicated1.getPregnancyGrade());
//        drugInfoNew.setLactationGradeInd(instructionsDeduplicated1.getLactationGrade());
//        drugInfoNew.setEffectCategoryInd(instructionsDeduplicated1.getEffectCategory());
//        drugInfoNew.setReferencesInd(instructionsDeduplicated1.getReferences());
//        drugInfoNew.setEffectAndUseInd(instructionsDeduplicated1.getEffectAndUse());
//        drugInfoNew.setMedicalInsuranceInd(instructionsDeduplicated1.getMedicalInsurance());
//        drugInfoNew.setCompositionAndCharacteristicsInd(instructionsDeduplicated1.getCompositionAndCharacteristics());
//        drugInfoNew.setImmunizationProgramAndDoseInd(instructionsDeduplicated1.getImmunizationProgramAndDose());
//        drugInfoNew.setPatientMedEduInd(instructionsDeduplicated1.getPatientMedEdu());
//        drugInfoNew.setVaccinationObjectInd(instructionsDeduplicated1.getVaccinationObject());
//        drugInfoNew.setImportLicenseNumInd(instructionsDeduplicated1.getImportLicenseNum());
//        drugInfoNew.setRadioactiveIsotopeHalfLifeInd(instructionsDeduplicated1.getRadioactiveIsotopeHalfLife());
//        drugInfoNew.setRadioactiveActivityAndMarkingTimeInd(instructionsDeduplicated1.getRadioactiveActivityAndMarkingTime());
//        drugInfoNew.setInternalRadiationAbsorbedDoseInd(instructionsDeduplicated1.getInternalRadiationAbsorbedDose());
//        drugInfoNew.setPackagingAddressInd(instructionsDeduplicated1.getPackagingAddress());
        drugInfoNew.setImages(instructionsDeduplicated1.getImages());

    }

    private void putDrugInfo(List<DrugInfoNew> drugInfoNews, List<DrugAndIndicationIndex> DrugAndIndicationIndexs) {
        mongoTemplate.insert(drugInfoNews, DrugInfoNew.class);
        elasticsearchRestTemplate.save(DrugAndIndicationIndexs);
    }


    // app

    

    // 新添加的生成 PDF 的方法
    public void guideDownloadPdf(String id, HttpServletResponse response) throws IOException, DocumentException {
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
        guideDownloadWord(id, mockResponse);

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
        try {
            fileName = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data").getString("title");
        } catch (NullPointerException e) {
            JSONObject data = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "drug_score_tra");
            ReportDownMode reportDownMode = JSON.parseObject(data.toJSONString(), ReportDownMode.class);
            fileName = reportDownMode.getTitle();
        }
        response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".pdf");
        ServletOutputStream pdfOutputStream = response.getOutputStream();
        try (FileInputStream pdfInputStream = new FileInputStream(tempPdfFile)) {
            IOUtils.copy(pdfInputStream, pdfOutputStream);
        }

        // 删除临时文件
        tempWordFile.delete();
        tempPdfFile.delete();

        log.info("----------指南报告 PDF 下载完成----------");
    }


    public void guideDownloadV2Pdf(String id, HttpServletResponse response) throws IOException, DocumentException {
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
        generateReport(mockResponse, id);

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
        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "tr_info_score_v2");
        if (jsonObjects != null) {
            fileName = jsonObjects.getString("simpleTitle");
        }
        response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".pdf");
        ServletOutputStream pdfOutputStream = response.getOutputStream();
        try (FileInputStream pdfInputStream = new FileInputStream(tempPdfFile)) {
            IOUtils.copy(pdfInputStream, pdfOutputStream);
        }

        // 删除临时文件
        tempWordFile.delete();
        tempPdfFile.delete();

        log.info("----------指南报告 PDF 下载完成----------");
    }


    

    @Override
    public void guideDownloadWords(String ids, HttpServletResponse response) throws IOException, DocumentException {
        log.info("*******************下载id：{}*****************", ids);
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=药品遴选分析报告.doc");
        ServletOutputStream outputStream = response.getOutputStream();
        // 创建一个文档（默认大小A4，边距36, 36, 36, 36）
        Document document = new Document();
        // 设置文档大小
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        // 创建writer，通过writer将文档写入磁盘
        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        // 打开文档，只有打开后才能往里面加东西
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

        String[] split = ids.split(",");
        int xx = 0;
        for (String id : split) {
            JSONObject drugAnalyzeData = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data");
            if (drugAnalyzeData != null) {
                if (xx != 0) {
                    document.newPage();
                }
                xx++;
                Font font = createFontWord(13, Font.NORMAL);
                String fileName = drugAnalyzeData.getString("title");
                String drugName = drugAnalyzeData.getString("drugName");
                String drugInfo = drugAnalyzeData.getString("drugInfo");
                String diseaseName = drugAnalyzeData.getString("disease");
                // 总得分
                String totalScore = drugAnalyzeData.getJSONObject("overallSummary").getString("comprehensiveScore");
                // 推荐情况
                String status = drugAnalyzeData.getJSONObject("overallSummary").getString("status");
                String recommendation = drugAnalyzeData.getJSONObject("overallSummary").getString("recommendation");
                // 药学特性
                String pharmaceuticalCharacteristicsScore = "0";
                // 有效性
                String effectivenessScore = "0";
                // 安全性
                String safetyScore = "0";
                // 经济性
                String economicalScore = "0";
                // 其他属性
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
                // 是否属于国家基本药物
                boolean essentialMedicines = false;
                // 否被纳入了国家医保目录
                boolean reimbursementList = false;
                String reimbursement = "";
                String paymentLimits = "";
                // 是否列为国家集中采购药品
                boolean procurementOfDrugs = false;
                // 国家基本药物得分
                String essentialMedicinesScore = "0";
                // 国家医保目录得分
                String reimbursementListScore = "0";
                // 国家集中采购药品得分
                String procurementOfDrugsScore = "0";
                JSONObject otherAttributes = drugAnalyzeData.getJSONObject("otherAttributes");
                if (otherAttributes != null) {
                    // 判定药品归属
                    essentialMedicines = otherAttributes.getBoolean("essentialMedicines");
                    paymentLimits = otherAttributes.getString("paymentLimits");
                    reimbursementList = otherAttributes.getBoolean("reimbursementList");
                    if (reimbursementList) {
                        reimbursement = otherAttributes.getString("reimbursement");
                    }
                    procurementOfDrugs = otherAttributes.getBoolean("procurementOfDrugs");
                    // 判定得分
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


                // 设置报告名称
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


                // 摘要 = 目的 + 方法 + 结果与结论
                document.newPage();
                Paragraph paragraph = new Paragraph();
                Chunk chunkAbstract = new Chunk("摘要：", createFontWord(12, Font.BOLD));
                paragraph.add(chunkAbstract);
                // 目的
                Chunk chunkObjective = new Chunk("目的 ", createFontWord(12, Font.BOLD));
                paragraph.add(chunkObjective);
                paragraph.add(new Chunk("依据《中国医疗机构药品评价与遴选快速指南（第二版）》（简称《指南》） 对" + drugName + "治疗" + diseaseName + "进行药品临床综合评价。", createFontWord(13, Font.NORMAL)));
                // 方法
                Chunk chunkMethod = new Chunk("方法 ", createFontWord(12, Font.BOLD));
                paragraph.add(chunkMethod);
                paragraph.add(new Chunk("该指南通过对药品药学特性（28分），有效性（27分），安全性（25分），经济性（10分）和其他属性（10分） 5 个方面内容，对" + drugName + "治疗" + diseaseName + "临床综合评价进行归纳总结。", createFontWord(13, Font.NORMAL)));
                // 结果与结论
                Chunk chunkConclusion = new Chunk("结果与结论 ", createFontWord(12, Font.BOLD));
                paragraph.add(chunkConclusion);
                recommendation = recommendation.replace("临床上", "");
//            paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，"+status+"临床上使用" + drugName + "用于治疗" + diseaseName + "。", createFontWord(13, Font.NORMAL)));
                paragraph.add(new Chunk("根据《指南》量化评分细则，" + drugName + "最终得分为" + totalScore + "分，" + recommendation, createFontWord(13, Font.NORMAL)));
                paragraph.setSpacingBefore(10);
                paragraph.setSpacingAfter(10);
                document.add(paragraph);
                // 一、评价目的
                document.add(createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT));
                Paragraph evaluationPurposeData = createDataWord("本研究通过药学特性、安全性、有效性、经济性以及其他属性5个维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。");
                evaluationPurposeData.setFirstLineIndent(25);
                document.add(evaluationPurposeData);
                // 二、评价药品
                document.add(createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT));
                Paragraph evaluationDrugData = createDataWord(drugInfo);
                evaluationDrugData.setFirstLineIndent(25);
                document.add(evaluationDrugData);
                // 三、评价过程
                document.add(createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT));
                Paragraph evaluationProcessData = createDataWord("本研究的研究方法主要是对" + drugName + "治疗" + diseaseName + "进行药品临床综合价值评估，根据《中国医疗机构药品评价与遴选快速指南（第二版）》进行量化打分，其评估维度包括药学特性、安全性、有效性、经济性以及其他属性。总分加和为100分。");
                evaluationProcessData.setFirstLineIndent(25);
                document.add(evaluationProcessData);
                // 四、评价结果
                document.add(createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT));
                Paragraph evaluationInfoData = createDataWord(drugName + "治疗" + diseaseName + "综合评价结果最终得分共计" + totalScore + "分，其中药学特性最终得分" + pharmaceuticalCharacteristicsScore + "分，有效性最终得分" + effectivenessScore + "分，安全性最终得分" + safetyScore + "分，经济性最终得分" + economicalScore + "分，其他属性最终得分" + otherAttributesScore + "分。具体评分结果如下：");
                evaluationInfoData.setFirstLineIndent(25);
                document.add(evaluationInfoData);
                // 1、药学特性（共28分，得分：24分）
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
                // 1.1 药理作用
                document.add(createHeadSecondWord("1.1 药理作用（" + pharmaceuticalScoreMap.get("药理作用") + "）"));
                Paragraph data11 = createDataWord(pharmaceuticalDataMap.get("药理作用"));
                data11.setFirstLineIndent(25);
                document.add(data11);
                // 1.2 体内过程
                document.add(createHeadSecondWord("1.2 体内过程（" + pharmaceuticalScoreMap.get("体内过程") + "）"));
                Paragraph data12 = createDataWord(pharmaceuticalDataMap.get("体内过程"));
                data12.setFirstLineIndent(25);
                document.add(data12);
                // 1.3 药剂学与使用方法
                document.add(createHeadSecondWord("1.3 药剂学与使用方法（" + pharmaceuticalScoreMap.get("药剂学与使用方法") + "）"));
                String txt12 = pharmaceuticalDataMap.get("药剂学与使用方法");
                if (StringUtils.isNotBlank(txt12)) {
                    Paragraph data13 = createDataWord(txt12.replaceAll("</br>", "\n"));
                    data13.setFirstLineIndent(25);
                    document.add(data13);
                }
                // 1.3 药品特性相关内容
// 1.3.1 成分
                document.add(createHeadSecondWord("1.3.1 成分（" + pharmaceuticalScoreMap.get("成分") + "）"));
                Paragraph data131 = createDataWord(pharmaceuticalDataMap.get("成分"));
                data131.setFirstLineIndent(25); // 首行缩进
                document.add(data131);

// 1.3.2 规格与包装
                document.add(createHeadSecondWord("1.3.2 规格与包装（" + pharmaceuticalScoreMap.get("规格与包装") + "）"));
                Paragraph data132 = createDataWord(pharmaceuticalDataMap.get("规格与包装"));
                data132.setFirstLineIndent(25);
                document.add(data132);

// 1.3.3 剂型
                document.add(createHeadSecondWord("1.3.3 剂型（" + pharmaceuticalScoreMap.get("剂型") + "）"));
                Paragraph data133 = createDataWord(pharmaceuticalDataMap.get("剂型"));
                data133.setFirstLineIndent(25);
                document.add(data133);

// 1.3.4 给药剂量
                document.add(createHeadSecondWord("1.3.4 给药剂量（" + pharmaceuticalScoreMap.get("给药剂量") + "）"));
                Paragraph data134 = createDataWord(pharmaceuticalDataMap.get("给药剂量"));
                data134.setFirstLineIndent(25);
                document.add(data134);

// 1.3.5 给药频次
                document.add(createHeadSecondWord("1.3.5 给药频次（" + pharmaceuticalScoreMap.get("给药频次") + "）"));
                Paragraph data135 = createDataWord(pharmaceuticalDataMap.get("给药频次"));
                data135.setFirstLineIndent(25);
                document.add(data135);

// 1.3.6 使用方便性
                document.add(createHeadSecondWord("1.3.6 使用方便性（" + pharmaceuticalScoreMap.get("使用方便性") + "）"));
                Paragraph data136 = createDataWord(pharmaceuticalDataMap.get("使用方便性"));
                data136.setFirstLineIndent(25);
                document.add(data136);

                // 1.4 贮藏条件
                document.add(createHeadSecondWord("1.4 贮藏条件（" + pharmaceuticalScoreMap.get("贮藏条件") + "）"));
                Paragraph data14 = createDataWord(pharmaceuticalDataMap.get("贮藏条件"));
                data14.setFirstLineIndent(25);
                document.add(data14);
                // 1.5 药品有效期
                document.add(createHeadSecondWord("1.5 药品有效期（" + pharmaceuticalScoreMap.get("有效期") + "）"));
                Paragraph data15 = createDataWord(pharmaceuticalDataMap.get("有效期"));
                data15.setFirstLineIndent(25);
                document.add(data15);
                // 2、有效性（共27分，得分：21分）
                document.add(createHeadWord(14, "2、有效性（共" + guideMaxMap.get("有效性") + "分，得分：" + effectivenessScore + "分）", Element.ALIGN_LEFT));
                JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
                if (effectiveness != null) {
                    // 适应症得分
                    String indicationScore = effectiveness.getString("indicationScore") != null ? effectiveness.getString("indicationScore") : "0";
                    // 证据推荐详情得分推荐得分
                    String guideAndLiteratureScore = effectiveness.getString("guideAndLiteratureScore") != null ? effectiveness.getString("guideAndLiteratureScore") : "0";
                    // 临床疗效得分
                    String effectiveScore = effectiveness.getString("effectivenessScore") != null ? effectiveness.getString("effectivenessScore") : "0";
                    // 2.1 适应症
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
                        // 2.2 指南推荐
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
                                if (i == 0) {
                                    continue;
                                } else {
                                    JSONArray jsonArray = effectivenessArr.getJSONArray(i);
                                    String guideContent = jsonArray.getString(1) + "发表的《" +
                                            jsonArray.getString(0) + "》，" + jsonArray.getString(4);
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
                            if (CollUtil.isEmpty(effectiveness.getJSONArray("literature"))) {
                                Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南或系统评价/Meta分析等证据推荐。");
                                effectivenessDataParagraph.setFirstLineIndent(25);
                                document.add(effectivenessDataParagraph);
                            } else {
                                // 2.2 文献推荐
                                String literature = effectiveness.getJSONArray("literature").toJSONString();
//                        Table literatureTable = new Table(4);
                                JSONArray literatureArr = JSONArray.parseArray(literature);
                                if (literatureArr.size() > 1) {
//                        document.add(createHeadSecondWord("2.2.1 文献推荐"));
                                    for (int i = 0; i < literatureArr.size(); i++) {
                                        JSONArray jsonArray = literatureArr.getJSONArray(i);

                                        String literatureContent = jsonArray.getString(1) + "发表的《" +
                                                jsonArray.getString(0) + "》，" + jsonArray.getString(4);
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
                    // 2.3 临床疗效
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
                // 3、安全性（共25分，得分：17.5分）
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
                // 3.1 中度不良反应
                document.add(createHeadSecondWord("3.1 中度不良反应（" + safetyScoreMap.get("中度不良反应") + "）"));
                Paragraph data31 = createDataWord(safetyDataMap.get("中度不良反应"));
                data31.setFirstLineIndent(25);
                document.add(data31);
                // 3.2 重度不良反应
                document.add(createHeadSecondWord("3.2 重度不良反应（" + safetyScoreMap.get("重度不良反应") + "）"));
                Paragraph data32 = createDataWord(safetyDataMap.get("重度不良反应"));
                data32.setFirstLineIndent(25);
                document.add(data32);
                // 3.3 特殊人群
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
                // 3.4 相互作用
                document.add(createHeadSecondWord("3.4 相互作用（" + safetyScoreMap.get("相互作用") + "）"));
                Paragraph data34 = createDataWord(safetyDataMap.get("相互作用"));
                data34.setFirstLineIndent(25);
                document.add(data34);
                // 3.5 其他
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

                // 4、经济性（共10分，得分：1.21分）
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
                // 5、其他属性（共10分，得分：5.8分）
                document.add(createHeadWord(14, "5、其他属性（共" + guideMaxMap.get("其他属性") + "分，得分：" + otherAttributesScore + "分）", Element.ALIGN_LEFT));
                // 5.1 国家医保
                document.add(createHeadSecondWord("5.1 国家医保（" + reimbursementListScore + "）"));
                Paragraph data51 = createDataWord(drugName + (reimbursementList ? "在国家医保目录中，属于医保" + reimbursement : "不在国家医保目录中。") + (reimbursementList ? (StringUtils.isNotBlank(paymentLimits) ? "，" + paymentLimits + ((StrUtil.endWith(paymentLimits, "。")) ? "" : "。") : "，无支付限制。") : ""));
                data51.setFirstLineIndent(25);
                document.add(data51);
                // 5.2 国家基本药物
                char triangleSymbol = (char) 30;
                document.add(createHeadSecondWord("5.2 国家基本药物（" + essentialMedicinesScore + "）"));
                Paragraph data52 = createDataWord(drugName + (essentialMedicines ? "已被纳入国家基本药物目录" : "并未被纳入国家基本药物目录。") + (essentialMedicines ? (("").equals(otherAttributes.getString("essentialType")) ? "，无△" : "，有") + otherAttributes.getString("essentialType") + "要求。" : ""));
                data52.setFirstLineIndent(25);
                document.add(data52);
                // 5.3 国家集中采购药品
                document.add(createHeadSecondWord("5.3 国家集中采购药品（" + procurementOfDrugsScore + "）"));
                Paragraph data53 = createDataWord(drugName + (procurementOfDrugs ? "已被" : "并未被") + "列为国家集中采购药品。");
                data53.setFirstLineIndent(25);
                document.add(data53);
                // 5.4 原研/参比/一致性评价
                assert otherAttributes != null;
                document.add(createHeadSecondWord("5.4 原研/参比/一致性评价（" + otherAttributes.getString("guideDrugSituationScore") + "）"));
                Paragraph data54 = createDataWord(otherAttributes.getString("guideDrugSituation"));
                data54.setFirstLineIndent(25);
                document.add(data54);
                // 5.5 生成企业状况
                document.add(createHeadSecondWord("5.5 生产企业状况（" + otherAttributes.getString("guideEnterpriseScore") + "）"));
                Paragraph data55 = createDataWord(otherAttributes.getString("guideEnterprise"));
                data55.setFirstLineIndent(25);
                document.add(data55);
                // 5.6 全球使用情况
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
            }

        }
        document.close();
        writer.close();
        log.info("----------指南报告下载完成----------");
    }

    @Override
    public void suDownloadWord(String id, HttpServletResponse response) throws IOException, DocumentException {
        JSONObject drugAnalyzeData = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData != null) {
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            Font font = createFontWord(14, Font.NORMAL);
            String drugName = drugAnalyzeData.getJSONObject("overallSummary").getString("targetDrug");
            String fileName = drugAnalyzeData.getString("title");
            String drugInfo = drugAnalyzeData.getString("drugInfo");
            // 总得分
            String totalScore = drugAnalyzeData.getJSONObject("overallSummary").getString("comprehensiveScore");
            // 安全性
            String safetyScore = "0";
            // 有效性
            String effectivenessScore = "0";
            // 适宜性
            String suitabilityScore = "0";
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
                    case "适宜性":
                        suitabilityScore = jsonObject.getString("value");
                        break;
                }
            }

            JSONObject safety = drugAnalyzeData.getJSONObject("safety");
            // 1.1 不良反应严重程度及发生率
            String safetyScore1 = "0";
            // 1.2 与同类药品相比安全性优势
            String safetyScore2 = "0";
            // 1.3 特殊人群用药情况
            String safetyScore3 = "0";
            // 1.4 药物警戒情况
            String safetyScore4 = "0";
            if (safety != null) {
                // 1.1 不良反应严重程度及发生率
                safetyScore1 = safety.getString("adverseReactionsScore");
                // 1.2 与同类药品相比安全性优势
                safetyScore2 = safety.getString("similarDrugsScore");
                // 1.3 特殊人群用药情况
                safetyScore3 = safety.getString("specialPopulationsScore");
                // 1.4 药物警戒情况
                safetyScore4 = safety.getString("pharmacovigilanceScore");
            }

            // 2.1 证据推荐情况：（44分）
            String effectivenessScore1 = "44";
            // 2.2 与同类药品相比，临床治疗有特别优势：（4分）
            String effectivenessScore2 = "4";
            JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
            if (effectiveness != null) {
                effectivenessScore1 = effectiveness.getString("guideScore");
                effectivenessScore2 = effectiveness.getString("advantageScore");
            }

            // 3.1 使用方法/依从性：（0分）
            String suitabilityScore1 = "0";
            // 3.2 贮藏条件（ 0分）
            String suitabilityScore2 = "0";
            // 3.3 若为复方制剂，其复方成分及配比是否规范（6分）
            String suitabilityScore3 = "0";
            // 3.4 皮试要求（4分）
            String suitabilityScore4 = "0";
            JSONObject suitability = drugAnalyzeData.getJSONObject("suitability");
            if (suitability != null) {
                suitabilityScore1 = suitability.getString("usageMethodScore");
                suitabilityScore2 = suitability.getString("storageScore");
                suitabilityScore3 = suitability.getString("compositionRatio");
                suitabilityScore4 = suitability.getString("skinScore");
            }

            // 是否属于国家基本药物
            boolean essentialMedicines = false;
            // 否被纳入了国家医保目录
            boolean reimbursementList = false;
            String paymentLimit = "";
            String reimbursement = "";
            JSONObject accessibility = drugAnalyzeData.getJSONObject("accessibility");
            if (accessibility != null) {
                paymentLimit = accessibility.getString("paymentLimit");
                essentialMedicines = accessibility.getBoolean("essentialMedicines");
                reimbursementList = accessibility.getBoolean("reimbursementList");
                if (reimbursementList) {
                    reimbursement = accessibility.getString("reimbursement");
                }
            }

            log.info("----------开始进行苏大一报告下载----------");
            response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
            ServletOutputStream outputStream = response.getOutputStream();
            // 创建一个文档（默认大小A4，边距36, 36, 36, 36）
            Document document = new Document();
            // 设置文档大小
            document.setPageSize(com.lowagie.text.PageSize.A4);
            document.setMargins(50, 50, 50, 50);
            // 创建writer，通过writer将文档写入磁盘
            RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
            // 打开文档，只有打开后才能往里面加东西
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

            // 设置报告名称
            Paragraph paragraphTitle = createDataWordV1(fileName);
            paragraphTitle.setAlignment(Element.ALIGN_CENTER);
            paragraphTitle.setSpacingBefore(220);
            paragraphTitle.setSpacingAfter(200);
            document.add(paragraphTitle);

            Paragraph headWord1 = createHeadWord(12, "灵犀量子（北京）医疗科技有限公司", Element.ALIGN_LEFT);
            headWord1.setAlignment(Element.ALIGN_CENTER);
            headWord1.setSpacingBefore(130);
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


            // 摘要 = 目的 + 方法 + 结果与结论
            document.newPage();
            // 摘要 = 目的 + 方法 + 结果与结论
            Paragraph paragraph = new Paragraph();
            Chunk chunkAbstract = new Chunk("摘要：", createFontWord(12, Font.BOLD));
            paragraph.add(chunkAbstract);
            // 目的
            Chunk chunkObjective = new Chunk("目的 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkObjective);
            paragraph.add(new Chunk("依据《苏州市抗菌药物遴选评价指标（区域）》对" + drugName + "进行药品临床综合评价。", createFontWord(13, Font.NORMAL)));
            // 方法
            Chunk chunkMethod = new Chunk("方法 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkMethod);
            paragraph.add(new Chunk("该评价量表通过对药品的安全性（34分），有效性（48分），适宜性（18分）3 个方面内容，对" + drugName + "临床综合评价进行归纳总结。", createFontWord(13, Font.NORMAL)));
            // 结果与结论
            Chunk chunkConclusion = new Chunk("结果与结论 ", createFontWord(12, Font.BOLD));
            paragraph.add(chunkConclusion);
            paragraph.add(new Chunk("根据《苏州市抗菌药物遴选评价指标（区域）》量化评分细则，" + drugName + "最终得分为" + totalScore + "分。", createFontWord(13, Font.NORMAL)));
            paragraph.setSpacingBefore(10);
            paragraph.setSpacingAfter(10);
            document.add(paragraph);
            // 一、评价目的
            document.add(createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT));
            Paragraph evaluationPurposeData = createDataWord("本研究通过安全性、有效性、以及适宜性3 个维度，进行量化打分，以期对进出医疗机构的药品进行客观的遴选与评价。");
            evaluationPurposeData.setFirstLineIndent(25);
            document.add(evaluationPurposeData);
            // 二、评价药品
            document.add(createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT));
            Paragraph evaluationDrugData = createDataWord(drugInfo);
            evaluationDrugData.setFirstLineIndent(25);
            document.add(evaluationDrugData);
            // 三、评价过程
            document.add(createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT));
            Paragraph evaluationProcessData = createDataWord("本研究的研究方法主要是对" + drugName + "进行药品临床综合价值评估，根据《苏州市抗菌药物遴选评价指标（区域）》进行量化打分，其评估维度包括安全性、有效性、适宜性。总分加和为100分。");
            evaluationProcessData.setFirstLineIndent(25);
            document.add(evaluationProcessData);
            Paragraph evaluationProcessData2 = createDataWord("本研究同时还涵盖了" + drugName + "可及性与经济性相关内容。");
            evaluationProcessData2.setFirstLineIndent(25);
            document.add(evaluationProcessData2);
            // 四、评价结果
            document.add(createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT));
            Paragraph evaluationInfoData = createDataWord(drugName + "综合评价结果最终得分共计" + totalScore + "分，其中安全性最终得分" + safetyScore + "分，有效性最终得分" + effectivenessScore + "分，适宜性最终得分" + suitabilityScore + "分。具体评分结果如下：");
            evaluationInfoData.setFirstLineIndent(25);
            document.add(evaluationInfoData);
            // 1、安全性（共34分，得分：14分）
            document.add(createHeadWord(14, "1、安全性（共34分，得分：" + safetyScore + "分）", Element.ALIGN_LEFT));
            Paragraph safetyData0 = createDataWord("安全性分析中，药品安全信息主要从说明书获得，其次是药监局发布的安全性相关的政策信息。");
            safetyData0.setFirstLineIndent(25);
            document.add(safetyData0);
            // 1.1 不良反应严重程度及发生率（4分）
            document.add(createHeadWord(12, "1.1 不良反应严重程度及发生率（" + safetyScore1 + "分）", Element.ALIGN_LEFT));
            if (safety != null) {
                JSONObject details = safety.getJSONObject("details");
                if (details != null) {
                    String adverseReactions = details.getString("adverseReactions");
                    Paragraph safetyData1;
                    if (StringUtils.isNotBlank(adverseReactions)) {
                        safetyData1 = createDataWord(adverseReactions);

                    } else {
                        safetyData1 = createDataWord("暂无数据");
                    }
                    safetyData1.setFirstLineIndent(25);
                    document.add(safetyData1);
                }
            }
            // 1.2 与同类药品相比安全性优势（4分）
            document.add(createHeadWord(12, "1.2 与同类药品相比安全性优势（" + safetyScore2 + "分）", Element.ALIGN_LEFT));
            if (safety != null) {
                JSONObject details = safety.getJSONObject("details");
                if (details != null) {
                    String similarDrugs = details.getString("similarDrugs");
                    Paragraph safetyData2;
                    if (StringUtils.isNotBlank(similarDrugs)) {
                        safetyData2 = createDataWord(similarDrugs);

                    } else {
                        safetyData2 = createDataWord("暂无数据");
                    }
                    safetyData2.setFirstLineIndent(25);
                    document.add(safetyData2);
                }
            }
            // 1.3 特殊人群用药情况（6分）
            document.add(createHeadWord(12, "1.3 特殊人群用药情况（" + safetyScore3 + "分）", Element.ALIGN_LEFT));
            if (safety != null) {
                JSONObject details = safety.getJSONObject("details");
                if (details != null) {
//                    String specialPopulations = details.getString("specialPopulations");
//                    Paragraph safetyData3;
//                    if (StringUtils.isNotBlank(specialPopulations)) {
//                        safetyData3 = createDataWord(specialPopulations);
//
//                    } else {
//                        safetyData3 = createDataWord("暂无数据");
//                    }
//                    safetyData3.setFirstLineIndent(25);
//                    document.add(safetyData3);
                    String string = details.getString("childrenMedicineInfant");
                    String string1 = details.getString("childrenMedicine");
                    String string2 = details.getString("pregnantWomen");
                    String string3 = details.getString("specialCrowdLiver");
                    String string4 = details.getString("specialCrowdKidney");
                    document.add(createHeadWordV1(12, "1.3.1 婴幼儿", Element.ALIGN_LEFT));
                    if (StringUtils.isNotBlank(string)) {
                        Paragraph safetyData3 = createDataWord(string);
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    } else {
                        Paragraph safetyData3 = createDataWord("暂无数据");
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    }
                    document.add(createHeadWordV1(12, "1.3.2 儿童", Element.ALIGN_LEFT));
                    if (StringUtils.isNotBlank(string1)) {
                        Paragraph safetyData3 = createDataWord(string1);
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    } else {
                        Paragraph safetyData3 = createDataWord("暂无数据");
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    }
                    document.add(createHeadWordV1(12, "1.3.3 孕妇及哺乳期妇女", Element.ALIGN_LEFT));
                    if (StringUtils.isNotBlank(string2)) {
                        Paragraph safetyData3 = createDataWord(string2);
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    } else {
                        Paragraph safetyData3 = createDataWord("暂无数据");
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    }
                    document.add(createHeadWordV1(12, "1.3.4 肝功能异常者", Element.ALIGN_LEFT));
                    if (StringUtils.isNotBlank(string3)) {
                        Paragraph safetyData3 = createDataWord(string3);
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    } else {
                        Paragraph safetyData3 = createDataWord("暂无数据");
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    }
                    document.add(createHeadWordV1(12, "1.3.5 肾功能异常者", Element.ALIGN_LEFT));
                    if (StringUtils.isNotBlank(string4)) {
                        Paragraph safetyData3 = createDataWord(string4);
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    } else {
                        Paragraph safetyData3 = createDataWord("暂无数据");
                        safetyData3.setFirstLineIndent(25);
                        document.add(safetyData3);
                    }


                }
            }
            // 1.4 药物警戒情况（0分）
            document.add(createHeadWord(12, "1.4 药物警戒情况（" + safetyScore4 + "分）", Element.ALIGN_LEFT));
            if (safety != null) {
                JSONObject details = safety.getJSONObject("details");
                if (details != null) {
                    String pharmacovigilance = details.getString("pharmacovigilance");
                    Paragraph safetyData4;
                    if (StringUtils.isNotEmpty(pharmacovigilance)) {
                        safetyData4 = createDataWord(pharmacovigilance);
                        safetyData4.setFirstLineIndent(25);
                        document.add(safetyData4);
                    } else {
                        safetyData4 = createDataWord("暂无数据");
                        safetyData4.setFirstLineIndent(25);
                        document.add(safetyData4);
                    }
                }
            }
            // 2、有效性（共48分，得分：48分）
            document.add(createHeadWord(14, "2、有效性（共48分，得分：" + effectivenessScore + "分）", Element.ALIGN_LEFT));
            Paragraph effectivenessData20 = createDataWord("有效性分析中，主要从临床指南/专家共识/诊疗规范获得。");
            effectivenessData20.setFirstLineIndent(25);
            document.add(effectivenessData20);
            // 2.1 证据推荐情况：（44分）
            document.add(createHeadWord(12, "2.1 证据推荐情况：（" + effectivenessScore1 + "分）", Element.ALIGN_LEFT));

            if (CollUtil.isNotEmpty(effectiveness.getJSONArray("guidePc"))) {
                JSONArray guidePc = effectiveness.getJSONArray("guidePc");
                int i = 1;
                for (JSONObject jsonObject : guidePc.toJavaList(JSONObject.class)) {
                    String showField = jsonObject.getString("showField");
                    String content = jsonObject.getString("content");
                    Paragraph fontWord = createDataWord("（" + i + "）" + showField);
                    Paragraph contentWord = createDataWord(content);
                    fontWord.setFirstLineIndent(25);
                    document.add(fontWord);
                    contentWord.setFirstLineIndent(30);
                    document.add(contentWord);
                    i++;
                }

            } else {
                // String effectivenessJson = "[\n" + "\t\t\t[\"指南名称\",\"发布机构\",\"发布日期\",\"推荐等级\",\"相关内容\"],\n" + "\t\t\t[\"标题\",\"发布机构名称\",\"时间/日期\",\"强推荐\",\"对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。\"],\n" + "\t\t\t[\"标题\",\"发布机构名称\",\"时间/日期\",\"强推荐\",\"对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。\"],\n" + "\t\t\t[\"标题\",\"发布机构名称\",\"时间/日期\",\"强推荐\",\"对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。\"],\n" + "\t\t\t[\"标题\",\"发布机构名称\",\"时间/日期\",\"强推荐\",\"对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。\"],\n" + "\t\t\t[\"标题\",\"发布机构名称\",\"时间/日期\",\"强推荐\",\"对于难治复发患者治疗增加了包含卡非佐米、泊马度胺、塞利尼索方案的推荐，仍强调自体造血干细胞移植对于适合移植患者仍然具有不可替代的地位。\"]\t\n" + "\t\t]";
                JSONArray effectivenessArr = new JSONArray();
                if (effectiveness != null) {
                    effectivenessArr = effectiveness.getJSONArray("table");
                }
                Table effectivenessTable = new Table(4);
                // JSONArray effectivenessArr = JSONArray.parseArray(effectivenessJson);
                if (CollUtil.isNotEmpty(effectivenessArr)) {
                    Paragraph effectivenessData21 = createDataWord("有以下指南中描述了" + drugName + "在临床上的应用：");
                    effectivenessData21.setFirstLineIndent(25);
                    document.add(effectivenessData21);
                    for (int i = 0; i < effectivenessArr.size(); i++) {
                        JSONArray jsonArray = effectivenessArr.getJSONArray(i);
                        if (i == 0) {
                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                String s = jsonArray.getString(i1);
                                Cell cell = new Cell(new Phrase(s, font));
                                cell.setBackgroundColor(new Color(221, 221, 221));
                                cell.setUseAscender(true);
                                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                                effectivenessTable.addCell(cell);
                            }
                        } else {
                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                String s = jsonArray.getString(i1);
                                if (i1 == 3) {
                                    Cell cell = new Cell(new Phrase(s, font));
                                    cell.setUseAscender(true);
                                    effectivenessTable.addCell(cell);
                                } else {
                                    effectivenessTable.addCell(createTableContentWord(s));
                                }
                            }
                        }
                    }
                    document.add(effectivenessTable);
                } else {
                    Paragraph effectivenessDataParagraph = createDataWord("暂未找到相关临床指南证据推荐。");
                    effectivenessDataParagraph.setFirstLineIndent(25);
                    document.add(effectivenessDataParagraph);
                }
            }
            // 2.2 与同类药品相比，临床治疗有特别优势：（4分）
            document.add(createHeadWord(12, "2.2 与同类药品相比，临床治疗有特别优势：（" + effectivenessScore2 + "分）", Element.ALIGN_LEFT));
            if (effectiveness != null) {
                String advantage = effectiveness.getString("advantage");
                if (StringUtils.isNotBlank(advantage)) {
                    Paragraph effectivenessData22 = createDataWord(advantage);
                    effectivenessData22.setFirstLineIndent(25);
                    document.add(effectivenessData22);
                }
            }

            // 3、适宜性（共18分，得分：10分）
            document.add(createHeadWord(14, "3、适宜性（共18分，得分：" + suitabilityScore + "分）", Element.ALIGN_LEFT));
            Paragraph suitabilityData30 = createDataWord("适宜性分析中，其内容主要从说明书获得。");
            suitabilityData30.setFirstLineIndent(25);
            document.add(suitabilityData30);
            // 3.1 使用方法/依从性：（0分）
            document.add(createHeadWord(12, "3.1 使用方法/依从性：（" + suitabilityScore1 + "分）", Element.ALIGN_LEFT));
            if (suitability != null) {
                JSONObject details = suitability.getJSONObject("details");
                if (details != null) {
                    String usageMethod = details.getString("usageMethod");
                    Paragraph suitabilityData31;
                    if (StringUtils.isNotBlank(usageMethod)) {
                        suitabilityData31 = createDataWord(usageMethod);
                    } else {
                        suitabilityData31 = createDataWord("暂无数据");
                    }
                    suitabilityData31.setFirstLineIndent(25);
                    document.add(suitabilityData31);
                }
            }
            // 3.2 贮藏条件（0分）
            document.add(createHeadWord(12, "3.2 贮藏条件（" + suitabilityScore2 + "分）", Element.ALIGN_LEFT));
            if (suitability != null) {
                JSONObject details = suitability.getJSONObject("details");
                if (details != null) {
                    String storageConditions = details.getString("storageConditions");
                    Paragraph suitabilityData32;
                    if (StringUtils.isNotBlank(storageConditions)) {
                        suitabilityData32 = createDataWord(storageConditions);
                    } else {
                        suitabilityData32 = createDataWord("暂无数据");
                    }
                    suitabilityData32.setFirstLineIndent(25);
                    document.add(suitabilityData32);
                }
            }
            // 3.3 若为复方制剂，其复方成分及配比是否规范（6分）
            document.add(createHeadWord(12, "3.3 若为复方制剂，其复方成分及配比是否规范（" + suitabilityScore3 + "分）", Element.ALIGN_LEFT));
            if (suitability != null) {
                JSONObject details = suitability.getJSONObject("details");
                if (details != null) {
                    String proportioningSituation = details.getString("proportioningSituation");
                    Paragraph suitabilityData33;
                    if (StringUtils.isNotBlank(proportioningSituation)) {
                        suitabilityData33 = createDataWord(proportioningSituation);
                    } else {
                        suitabilityData33 = createDataWord("暂无数据");
                    }
                    suitabilityData33.setFirstLineIndent(25);
                    document.add(suitabilityData33);
                }
            }
            // 3.4 皮试要求（4分）
            document.add(createHeadWord(12, "3.4 皮试要求（" + suitabilityScore4 + "分）", Element.ALIGN_LEFT));
            if (suitability != null) {
                JSONObject details = suitability.getJSONObject("details");
                if (details != null) {
                    String skinTestSituation = details.getString("skinTestSituation");
                    Paragraph suitabilityData34;
                    if (StringUtils.isNotBlank(skinTestSituation)) {
                        suitabilityData34 = createDataWord(skinTestSituation);
                    } else {
                        suitabilityData34 = createDataWord("暂无数据");
                    }
                    suitabilityData34.setFirstLineIndent(25);
                    document.add(suitabilityData34);
                }
            }
            // 4、可及性
            document.add(createHeadWord(14, "4、可及性", Element.ALIGN_LEFT));
            // 4.1 国家基本药物收录情况
            document.add(createHeadWord(12, "4.1 国家基本药物收录情况", Element.ALIGN_LEFT));
            Paragraph data41 = createDataWord(drugName + (essentialMedicines ? "已被纳入国家基本药物目录" : "并未被纳入国家基本药物目录。") + (essentialMedicines ? (("").equals(accessibility.getString("essentialType")) ? "，无" : "，有") + accessibility.getString("essentialType") + "要求。" : ""));
            data41.setFirstLineIndent(25);
            document.add(data41);
            // 4.2 国家医保目录收录情况
            document.add(createHeadWord(12, "4.2 国家医保目录收录情况", Element.ALIGN_LEFT));
            Paragraph data42 = createDataWord(drugName + (reimbursementList ? "在国家医保目录中，属于医保" + reimbursement : "不在国家医保目录中。") + (reimbursementList ? (StringUtils.isNotBlank(paymentLimit) ? "，" + paymentLimit + ((StrUtil.endWith(paymentLimit, "。")) ? "" : "。") : "，无支付限制。") : ""));
            data42.setFirstLineIndent(25);
            document.add(data42);
            // 5、经济性
            document.add(createHeadWord(14, "5、经济性", Element.ALIGN_LEFT));
            JSONObject economical = drugAnalyzeData.getJSONObject("economical");
            // 阿司匹林肠溶片不同厂家的价格情况：
            document.add(createHeadWord(12, drugName + "不同厂家的价格情况：", Element.ALIGN_LEFT));
            // String json1 = "[\n" + "\t\t\t[\"药品名称\",\"药品规格\",\"转换比\",\"单位\",\"生产企业\",\"中标价（元）\",\"价格中位值（元）\",\"价格四分位值（元）\"],\n" + "\t\t\t[\"阿司匹林肠溶片\",\"0.3g\",\"1\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"阿司匹林肠溶片\",\"0.3g\",\"1\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"阿司匹林肠溶片\",\"0.3g\",\"1\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"阿司匹林肠溶片\",\"0.3g\",\"1\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"阿司匹林肠溶片\",\"0.3g\",\"1\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"]\n" + "\t\t]";
            Table table1 = new Table(7);
            JSONArray arr1 = new JSONArray();
            if (economical != null) {
                arr1 = economical.getJSONArray("manufacturerList");
            }
            if (arr1.size() > 1) {
                for (int i = 0; i < arr1.size(); i++) {
                    JSONArray jsonArray = arr1.getJSONArray(i);
                    if (i == 0) {
                        for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                            String s = jsonArray.getString(i1);
                            Cell cell = new Cell(new Phrase(s, font));
                            cell.setBackgroundColor(new Color(221, 221, 221));
                            cell.setUseAscender(true);
                            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                            table1.addCell(cell);
                        }
                    } else {
                        for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                            String s = jsonArray.getString(i1);
                            Cell cell = new Cell(s);
                            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                            if (i == 1 && i1 == jsonArray.size() - 1) {
                                cell.setRowspan(arr1.size() - 1);
                            } else if (i != 1 && i1 == jsonArray.size() - 1) {
                                continue;
                            }
                            table1.addCell(cell);

                        }
                    }
                }
                document.add(table1);
            } else {
                Paragraph dataParagraph = createDataWord("暂无数据");
                dataParagraph.setFirstLineIndent(25);
                document.add(dataParagraph);
            }
            // 与阿司匹林肠溶片为同类药品的价格情况：
            document.add(createHeadWord(12, "与" + drugName + "为同类药品的价格情况：", Element.ALIGN_LEFT));
            // String json2 = "[\n" + "\t\t\t[\"药品名称\",\"药品规格\",\"转换比\",\"单位\",\"生产企业\",\"中标价（元）\",\"价格中位值（元）\",\"价格四分位值（元）\"],\n" + "\t\t\t[\"布洛芬缓释胶囊\",\"0.3g\",\"20\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"布洛芬缓释胶囊\",\"0.3g\",\"20\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"布洛芬缓释胶囊\",\"0.3g\",\"20\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"布洛芬缓释胶囊\",\"0.3g\",\"20\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"],\n" + "\t\t\t[\"布洛芬缓释胶囊\",\"0.3g\",\"20\",\"盒\",\"江苏恒瑞医药股份有限公司\",\"XX\",\"XX\",\"XX\"]\n" + "\t\t]";
            Table table2 = new Table(7);
            JSONArray arr2 = new JSONArray();
            if (economical != null) {
                arr2 = economical.getJSONArray("similarDrugsList");
            }
            if (arr2.size() > 1) {
                String mi = "";
                for (int i = 0; i < arr2.size(); i++) {
                    JSONArray jsonArray = arr2.getJSONArray(i);
                    if (i == 0) {
                        for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                            String s = jsonArray.getString(i1);
                            Cell cell = new Cell(new Phrase(s, font));
                            cell.setBackgroundColor(new Color(221, 221, 221));
                            cell.setUseAscender(true);
                            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                            table2.addCell(cell);
                        }
                    } else {
                        for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                            String s = jsonArray.getString(i1);
                            Cell cell = new Cell(s);
                            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                            if (i == 1 && i1 == jsonArray.size() - 1) {
                                cell.setRowspan(arr2.size() - 1);
                            } else if (i != 1 && i1 == jsonArray.size() - 1) {
                                continue;
                            }
                            table2.addCell(cell);
                        }
                    }
                }

                document.add(table2);
            } else {
                Paragraph dataParagraph = createDataWord("暂无数据");
                dataParagraph.setFirstLineIndent(25);
                document.add(dataParagraph);
            }
            // 关闭文档，才能输出
            document.close();
            writer.close();
            log.info("----------苏大一报告下载完成----------");
        }
    }

    @Override
    public void suDownloadExcel(String id, HttpServletResponse response) throws IOException {
        JSONObject drugAnalyzeData = mongoTemplate.findById(id, JSONObject.class, "drug_analyze_data");
        if (drugAnalyzeData != null) {
            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/vnd.ms-excel;charset=gb2312");
            String fileName = drugAnalyzeData.getString("drugInfo");
            String drugName = drugAnalyzeData.getJSONObject("overallSummary").getString("targetDrug");
            String[] split = fileName.split("-");
            // 剂型
            String dosageForm = "-";
            // 规格
            String specifications = "-";
            if (split.length > 2) {
                specifications = split[1];
            }
            response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".xlsx");
            // 实例化HSSFWorkbook
            HSSFWorkbook workbook = new HSSFWorkbook();
            // 创建一个Excel表单，参数为sheet的名字
            HSSFSheet sheet = workbook.createSheet("sheet");
            // 设置表头
            List<String> headList = Arrays.asList("项目", "得分", "证据描述", "证据来源", "首选推荐或优势情况");
            // 起始行,结束行,起始列,结束列
            CellRangeAddress callRangeAddress1 = new CellRangeAddress(0, 0, 0, 1);
            sheet.addMergedRegion(callRangeAddress1);

            // 设置列宽，setColumnWidth的第二个参数要乘以256，这个参数的单位是1/256个字符宽度
            for (int i = 0; i <= headList.size(); i++) {
                sheet.setColumnWidth(i, 15 * 256);
            }
            // 设置标题为居中加粗
            HSSFCellStyle style = workbook.createCellStyle();
            HSSFFont font = workbook.createFont();
            font.setBold(true);
            style.setFont(font);
            style.setAlignment(HorizontalAlignment.CENTER);
            style.setVerticalAlignment(VerticalAlignment.CENTER);
            // 设置内容为居中
            HSSFCellStyle style1 = workbook.createCellStyle();
            style1.setAlignment(HorizontalAlignment.CENTER);
            style1.setVerticalAlignment(VerticalAlignment.CENTER);
            // 设置内容为左对齐
            HSSFCellStyle style2 = workbook.createCellStyle();
            style2.setAlignment(HorizontalAlignment.LEFT);
            style2.setVerticalAlignment(VerticalAlignment.TOP);
            // 创建表头名称
            HSSFRow row = sheet.createRow(0);
            HSSFCell cell;
            for (int j = 0; j < headList.size(); j++) {
                if (j == 0) {
                    cell = row.createCell(j);
                } else {
                    cell = row.createCell(j + 1);
                }
                cell.setCellValue(headList.get(j));
                cell.setCellStyle(style);
            }
            // 设置单元格并赋值
            // 基本信息
            CellRangeAddress callRangeAddress2 = new CellRangeAddress(1, 3, 0, 0);
            sheet.addMergedRegion(callRangeAddress2);
            List<List<String>> list1 = Arrays.asList(Arrays.asList("药品通用名", drugName, "/", "/", "/"), Arrays.asList("剂型（注射/口服）", dosageForm, "/", "/", "/"), Arrays.asList("规格", specifications, "/", "/", "/"));
            Map<String, List<List<String>>> map1 = new HashMap<>();
            map1.put("基本信息", list1);
            Set<Entry<String, List<List<String>>>> entries1 = map1.entrySet();
            for (Entry<String, List<List<String>>> stringListEntry : entries1) {
                String key = stringListEntry.getKey();
                List<List<String>> value = stringListEntry.getValue();
                for (int i = 0; i < value.size(); i++) {
                    List<String> list = value.get(i);
                    HSSFRow row1 = sheet.createRow(i + 1);
                    if (i == 0) {
                        cell = row1.createCell(0);
                        cell.setCellValue(key);
                        cell.setCellStyle(style);
                    }
                    for (int i1 = 0; i1 < list.size(); i1++) {
                        cell = row1.createCell(i1 + 1);
                        cell.setCellValue(list.get(i1));
                        cell.setCellStyle(style1);
                    }
                }
            }
            // 药学属性
            CellRangeAddress callRangeAddress3 = new CellRangeAddress(4, 6, 0, 0);
            sheet.addMergedRegion(callRangeAddress3);
            // 总得分
            String totalScore = drugAnalyzeData.getJSONObject("overallSummary").getString("comprehensiveScore");
            // 安全性
            String safetyScore = "0";
            // 有效性
            String effectivenessScore = "0";
            // 适宜性
            String suitabilityScore = "0";
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
                    case "适宜性":
                        suitabilityScore = jsonObject.getString("value");
                        break;
                }
            }
            // 安全性数据拼接
            StringBuilder safetyBuilder = new StringBuilder();
            JSONObject safety = drugAnalyzeData.getJSONObject("safety");
            if (safety != null) {
                JSONObject details = safety.getJSONObject("details");
                if (details != null) {
                    // 不良反应严重程度及发生率
                    String adverseReactions = details.getString("adverseReactions");
                    if (StringUtils.isNotBlank(adverseReactions)) {
                        safetyBuilder.append("不良反应严重程度及发生率").append("\n").append(adverseReactions).append("\n");
                    }
                    // 与同类药品相比安全性优势
                    String similarDrugs = details.getString("similarDrugs");
                    if (StringUtils.isNotBlank(similarDrugs)) {
                        safetyBuilder.append("与同类药品相比安全性优势").append("\n").append(similarDrugs).append("\n");
                    }
                    // 特殊人群用药情况
                    String specialPopulations = details.getString("specialPopulations");
                    if (StringUtils.isNotBlank(specialPopulations)) {
                        safetyBuilder.append("特殊人群用药情况").append("\n").append(specialPopulations).append("\n");
                    }
                    // 药物警戒情况
                    String pharmacovigilance = details.getString("pharmacovigilance");
                    if (StringUtils.isNotBlank(pharmacovigilance)) {
                        safetyBuilder.append("药物警戒情况").append("\n").append(pharmacovigilance).append("\n");
                    }
                }
            }
            // 有效性数据拼接
            StringBuilder effectivenessBuilder = new StringBuilder();
            JSONObject effectiveness = drugAnalyzeData.getJSONObject("effectiveness");
            if (effectiveness != null) {
                JSONArray table = effectiveness.getJSONArray("table");
                if (CollUtil.isNotEmpty(table) && table.size() > 1) {
                    effectivenessBuilder.append("指南推荐").append("\n");
                    for (int i = 1; i < table.size(); i++) {
                        JSONArray jsonArray = table.getJSONArray(i);
                        String title = jsonArray.getString(0);
                        String date = jsonArray.getString(2);
                        String info = jsonArray.getString(3);
                        effectivenessBuilder.append(date).append(" ").append(title).append("中指出：").append(info).append("\n");
                    }
                }
            }
//            if (effectiveness != null) {
//                JSONArray table = effectiveness.getJSONArray("guidePc");
//                if (CollUtil.isNotEmpty(table) && table.size() > 1) {
//                    effectivenessBuilder.append("指南推荐").append("\n");
//                    for (int i = 1; i < table.size(); i++) {
//                        JSONObject o = JSONObject.parseObject(table.get(i).toString());
//                        String o1 = o.getString("showField");
//                        String o2 = o.getString("content");
//                        effectivenessBuilder.append(o1).append("中指出：").append(o2).append("\n");
//                    }
//                }
//            }
            // 适宜性数据拼接
            StringBuilder suitabilityBuilder = new StringBuilder();
            JSONObject suitability = drugAnalyzeData.getJSONObject("suitability");
            if (suitability != null) {
                JSONObject details = suitability.getJSONObject("details");
                if (details != null) {
                    // 使用方法/依从性
                    String usageMethod = details.getString("usageMethod");
                    if (StringUtils.isNotBlank(usageMethod)) {
                        suitabilityBuilder.append("使用方法/依从性").append("\n").append(usageMethod).append("\n");
                    }
                    // 贮藏条件
                    String storageConditions = details.getString("storageConditions");
                    if (StringUtils.isNotBlank(storageConditions)) {
                        suitabilityBuilder.append("贮藏条件").append("\n").append(storageConditions).append("\n");
                    }
                    // 复方成分及配比是否规范
                    String proportioningSituation = details.getString("proportioningSituation");
                    if (StringUtils.isNotBlank(proportioningSituation)) {
                        suitabilityBuilder.append("复方成分及配比是否规范").append("\n").append(proportioningSituation).append("\n");
                    }
                    // 皮试要求
                    String skinTestSituation = details.getString("skinTestSituation");
                    if (StringUtils.isNotBlank(skinTestSituation)) {
                        suitabilityBuilder.append("皮试要求").append("\n").append(skinTestSituation).append("\n");
                    }
                }
            }
            List<List<String>> list2 = Arrays.asList(Arrays.asList("安全性", safetyScore, safetyBuilder.toString(), "说明书", "无"),
                    Arrays.asList("有效性", effectivenessScore, effectivenessBuilder.toString(), "指南", "无"),
                    Arrays.asList("适宜性", suitabilityScore, suitabilityBuilder.toString(), "说明书", "无"));
            Map<String, List<List<String>>> map2 = new HashMap<>();
            map2.put("药学属性", list2);
            Set<Entry<String, List<List<String>>>> entries2 = map2.entrySet();
            for (Entry<String, List<List<String>>> stringListEntry : entries2) {
                String key = stringListEntry.getKey();
                List<List<String>> value = stringListEntry.getValue();
                for (int i = 0; i < value.size(); i++) {
                    List<String> list = value.get(i);
                    HSSFRow row1 = sheet.createRow(i + 4);
                    if (i == 0) {
                        cell = row1.createCell(0);
                        cell.setCellValue(key);
                        cell.setCellStyle(style);
                    }
                    for (int i1 = 0; i1 < list.size(); i1++) {
                        cell = row1.createCell(i1 + 1);
                        cell.setCellValue(list.get(i1));
                        if (i1 == 2) {
                            cell.setCellStyle(style2);
                        } else {
                            cell.setCellStyle(style1);
                        }
                    }
                }
            }
            // 经济属性
            List<String> list3 = Arrays.asList("经济属性", "经济性");
            HSSFRow row3 = sheet.createRow(7);
            for (int i = 0; i < list3.size(); i++) {
                cell = row3.createCell(i);
                cell.setCellValue(list3.get(i));
                if (i == 0) {
                    cell.setCellStyle(style);
                } else {
                    cell.setCellStyle(style1);
                }
            }
            // 政策属性
            CellRangeAddress callRangeAddress4 = new CellRangeAddress(8, 9, 0, 0);
            sheet.addMergedRegion(callRangeAddress4);
            // 是否属于国家基本药物
            boolean essentialMedicines = false;
            // 否被纳入了国家医保目录
            boolean reimbursementList = false;
            String reimbursement = "";
            JSONObject accessibility = drugAnalyzeData.getJSONObject("accessibility");
            if (accessibility != null) {
                essentialMedicines = accessibility.getBoolean("essentialMedicines");
                reimbursementList = accessibility.getBoolean("reimbursementList");
                if (reimbursementList) {
                    reimbursement = accessibility.getString("reimbursement");
                }
            }
            List<List<String>> list4 = Arrays.asList(Arrays.asList("基本药物", "", (essentialMedicines ? "" : "非") + "基药", "《国家基本药物目录》"), Arrays.asList("医保属性", "", reimbursementList ? reimbursement : "无", "《国家医保药品目录》"));
            Map<String, List<List<String>>> map4 = new HashMap<>();
            map4.put("政策属性", list4);
            Set<Entry<String, List<List<String>>>> entries4 = map4.entrySet();
            for (Entry<String, List<List<String>>> stringListEntry : entries4) {
                String key = stringListEntry.getKey();
                List<List<String>> value = stringListEntry.getValue();
                for (int i = 0; i < value.size(); i++) {
                    List<String> list = value.get(i);
                    HSSFRow row4 = sheet.createRow(i + 8);
                    if (i == 0) {
                        cell = row4.createCell(0);
                        cell.setCellValue(key);
                        cell.setCellStyle(style);
                    }
                    for (int i1 = 0; i1 < list.size(); i1++) {
                        cell = row4.createCell(i1 + 1);
                        cell.setCellValue(list.get(i1));
                        cell.setCellStyle(style1);
                    }
                }
            }
            // 药学评分
            List<String> list5 = Arrays.asList("", "药学评分", totalScore);
            HSSFRow row5 = sheet.createRow(10);
            for (int i = 0; i < list5.size(); i++) {
                cell = row5.createCell(i);
                cell.setCellValue(list5.get(i));
                cell.setCellStyle(style1);
            }
            // 总得分
            List<String> list6 = Arrays.asList("", "总得分", totalScore);
            HSSFRow row6 = sheet.createRow(11);
            for (int i = 0; i < list6.size(); i++) {
                cell = row6.createCell(i);
                cell.setCellValue(list6.get(i));
                cell.setCellStyle(style1);
            }
            // 设置浏览器下载
            OutputStream os = new BufferedOutputStream(response.getOutputStream());
            // 将excel写入到输出流中
            workbook.write(os);
            os.flush();
            os.close();
        }
    }

    @Override
    public JSONObject urlToBase64(String url) {
        JSONObject result = new JSONObject();
        url = UnicodeUtil.toString(url);
        url = url.replace("https://image.evimed.com/pmc/instruction_for_select/", "https://image.evimed.com/oss/instructions/pdfs/");
        // 获取url的文件后缀
        String[] split = url.split("\\.");
        result.put("type", split[split.length - 1]);
        /*List<String> asList = Arrays.asList("http://image.evimed.com/230711-区域医疗机构抗菌药物遴选指标体系构建.pdf",
                "http://image.evimed.com/医疗机构药品评价与遴选量化记录表(1).pdf");*/
        List<String> asList = Arrays.asList("http://image.evimed.com/230711-%E5%8C%BA%E5%9F%9F%E5%8C%BB%E7%96%97%E6%9C%BA%E6%9E%84%E6%8A%97%E8%8F%8C%E8%8D%AF%E7%89%A9%E9%81%B4%E9%80%89%E6%8C%87%E6%A0%87%E4%BD%93%E7%B3%BB%E6%9E%84%E5%BB%BA.pdf",
                "http://image.evimed.com/%E5%8C%BB%E7%96%97%E6%9C%BA%E6%9E%84%E8%8D%AF%E5%93%81%E8%AF%84%E4%BB%B7%E4%B8%8E%E9%81%B4%E9%80%89%E9%87%8F%E5%8C%96%E8%AE%B0%E5%BD%95%E8%A1%A8(1).pdf");
        List<String> urlList = new ArrayList<>(asList);
        if (urlList.contains(url) || url.contains("instructions")) {
            byte[] bytes = HttpUtil.downloadBytes(url);
            if (bytes.length > 0) {
                result.put("base", Base64.encode(bytes));
            }
        } else {
            if (url.contains("M00")) {
                try (InputStream inputStream = FastDFSClient.downloadFile("group1", url)) {
                    byte[] data;
                    ByteArrayOutputStream swapStream = new ByteArrayOutputStream();
                    byte[] buff = new byte[100];
                    int rc;
                    assert inputStream != null;
                    while ((rc = inputStream.read(buff, 0, 100)) > 0) {
                        swapStream.write(buff, 0, rc);
                    }
                    data = swapStream.toByteArray();
                    result.put("base", Base64.encode(data));
                } catch (IOException e) {
                    e.printStackTrace();
                }
            } else {
                // url = url.replaceAll("\\.\\.", "");
                // url = url.replaceAll("/|jndi", "//");
                int indexOf = url.lastIndexOf("/");
                String pdfName = url.substring(indexOf);
                url = url.substring(0, indexOf);
                indexOf = url.lastIndexOf("/");
                String type = url.substring(indexOf);
                String txt = HttpUtil.get("https://m.evimed.com/resource/instructions/64" + type + pdfName);
                if (StringUtils.isNotBlank(txt)) {
                    result.put("base", txt);
                }
            }
        }
        String base = result.getString("base");
        if (StringUtils.isBlank(base)) {
            result.put("base", "");
        }
        return result;
    }


    //========================================方法=============================================

    /**
     * 通过药品分类查询药品名称
     *
     * @param drugClass 药品分类名称
     * @return 该药品分类下所有药品名称
     */
    public List<String> searchDrugs(String drugClass) {
        List<String> list = new ArrayList<>();
        Criteria criteria = new Criteria();
        // 转义正则表达式中的特殊字符
        String escapedDrugClass = drugClass.replaceAll("([\\\\\\.\\[\\]\\{\\}\\(\\)\\*\\+\\?\\^\\$\\|])", "\\\\$1");
        criteria.orOperator(
                Criteria.where("level1").regex(escapedDrugClass, "i"),
                Criteria.where("level2").regex(escapedDrugClass, "i"),
                Criteria.where("level3").regex(escapedDrugClass, "i"),
                Criteria.where("level4").regex(escapedDrugClass, "i"),
                Criteria.where("level5").regex(escapedDrugClass, "i")
        );
        List<JSONObject> andDrugs = mongoTemplate.find(new Query(criteria), JSONObject.class, "drug_category");
        if (CollectionUtil.isNotEmpty(andDrugs)) {
            for (JSONObject andDrug : andDrugs) {
                String string = andDrug.getString("level5");
                if (StringUtils.isNotBlank(string)) {
                    list.add(string);
                } else {
                    list.add(andDrug.getString("drugName"));
                }
            }
        }
        if (list.size() > 50) {
            list = list.subList(0, 50);
        }
        return list;
    }

    @Override
    public void insertGradeAndDrugsTable() {
        long startTime = System.currentTimeMillis();
        ExcelReader reader = ExcelUtil.getReader(FileUtil.file("C:\\Users\\86131\\Downloads\\药品分类-药理学（基于用药参考APP）-20250107.xlsx"), 0);
        List<Map<String, Object>> readAll = reader.readAll();
        log.info("共查询出药品数量为[{}]", readAll.size());
        // 用于存储当前词与等级关系
        Map<String, String> codeMap1 = new HashMap<>();
        Map<String, String> codeMap2 = new HashMap<>();
        Map<String, String> codeMap3 = new HashMap<>();
        Map<String, String> codeMap4 = new HashMap<>();
        Map<String, String> codeMap5 = new HashMap<>();
        // 生成随机三位数
        Random random = new Random();
        List<GradeAndDrugs> list = new ArrayList<>();
        // 记录数据处理进程
        int num = 0;
        for (Map<String, Object> map : readAll) {
            String firstCode;
            String firstGrade = map.get("一级分类") == null ? "" : map.get("一级分类").toString().toLowerCase();
            String secondCode;
            String secondGrade = map.get("二级分类") == null ? "" : map.get("二级分类").toString().toLowerCase();
            String thirdCode;
            String thirdGrade = map.get("三级分类") == null ? "" : map.get("三级分类").toString().toLowerCase();
            String fourthCode;
            String fourthGrade = map.get("四级分类") == null ? "" : map.get("四级分类").toString().toLowerCase();
            String fifthCode;
            String fifthGradeZh = map.get("有效成份") == null ? "" : map.get("有效成份").toString().toLowerCase();
            String type = map.get("药品类别") == null ? "" : map.get("药品类别").toString().toLowerCase();
            if (StringUtils.isNotBlank(fifthGradeZh) && "阿达木单抗".equals(fifthGradeZh)) {
                log.info("阿达木单抗");
            }

            String fifthGradeEn = map.get("五级英文") == null ? "" : map.get("五级英文").toString().toLowerCase();
            String drugZh = map.get("药品名称") == null ? "" : map.get("药品名称").toString().toLowerCase();
            if (StringUtils.isBlank(fifthGradeZh) && StringUtils.isNotBlank(drugZh)) {
                List<JSONObject> objects = mongoTemplate.find(new Query(Criteria.where("药品名称").is(drugZh)), JSONObject.class, "Sheet1");
                if (CollectionUtil.isNotEmpty(objects)) {
                    for (JSONObject object : objects) {
                        if (object.containsKey("有效成份") && StringUtils.isNotEmpty(object.getString("有效成份"))) {
                            fifthGradeZh = object.getString("有效成份");
                            break;
                        }
                    }
                }
            }
            String drugEn = map.get("药品名称英文") == null ? "" : map.get("药品名称英文").toString().toLowerCase();
            // 开始进行编码编写
            // 一级
            if (StringUtils.isNotBlank(firstGrade)) {
                // 存在一级
                if (codeMap1.containsKey(firstGrade)) {
                    firstCode = codeMap1.get(firstGrade);
                } else {
                    firstCode = "" + (random.nextInt(900) + 100);
                    codeMap1.put(firstGrade, firstCode);
                    GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(firstGrade), new ArrayList<>(), firstCode, 0, type);
                    list.add(gradeAndDrugs);
                    continue;

                }
            } else {
                firstCode = "" + (random.nextInt(900) + 100);
            }
            // 二级
            if (StringUtils.isNotBlank(secondGrade)) {
                // 存在二级
                if (codeMap2.containsKey(secondGrade)) {
                    String txt = codeMap2.get(secondGrade);
                    if (txt.contains(firstCode)) {
                        secondCode = txt;
                    } else {
                        secondCode = firstCode + "." + (random.nextInt(900) + 100);
                        codeMap2.put(secondGrade, secondCode);
                        GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(secondGrade), new ArrayList<>(), secondCode, 1, type);
                        list.add(gradeAndDrugs);
                        continue;
                    }
                } else {
                    secondCode = firstCode + "." + (random.nextInt(900) + 100);
                    codeMap2.put(secondGrade, secondCode);
                    GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(secondGrade), new ArrayList<>(), secondCode, 1, type);
                    list.add(gradeAndDrugs);
                    continue;
                }
            } else {
                secondCode = firstCode + "." + (random.nextInt(900) + 100);
            }
            // 三级
            if (StringUtils.isNotBlank(thirdGrade)) {
                // 存在三级
                if (codeMap3.containsKey(thirdGrade)) {
                    String txt = codeMap3.get(thirdGrade);
                    if (txt.contains(secondCode)) {
                        thirdCode = txt;
                    } else {
                        thirdCode = secondCode + "." + (random.nextInt(900) + 100);
                        codeMap3.put(thirdGrade, thirdCode);
                        GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(thirdGrade), new ArrayList<>(), thirdCode, 2, type);
                        list.add(gradeAndDrugs);
                        continue;
                    }
                } else {
                    thirdCode = secondCode + "." + (random.nextInt(900) + 100);
                    codeMap3.put(thirdGrade, thirdCode);
                    GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(thirdGrade), new ArrayList<>(), thirdCode, 2, type);
                    list.add(gradeAndDrugs);
                    continue;
                }
            } else {
                thirdCode = secondCode + "." + (random.nextInt(900) + 100);
            }
            // 四级
            if (StringUtils.isNotBlank(fourthGrade)) {
                // 存在四级
                if (codeMap4.containsKey(fourthGrade)) {
                    String txt = codeMap4.get(fourthGrade);
                    if (txt.contains(thirdCode)) {
                        fourthCode = txt;
                    } else {
                        fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
                        codeMap4.put(fourthGrade, fourthCode);
                        GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(fourthGrade), new ArrayList<>(), fourthCode, 3, type);
                        list.add(gradeAndDrugs);
                        continue;
                    }
                } else {
                    fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
                    codeMap4.put(fourthGrade, fourthCode);
                    GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), Collections.singletonList(fourthGrade), new ArrayList<>(), fourthCode, 3, type);
                    list.add(gradeAndDrugs);
                    continue;
                }
            } else {
                fourthCode = thirdCode + "." + (random.nextInt(900) + 100);
            }


            // 五级
            if (StringUtils.isNotBlank(fifthGradeZh) || StringUtils.isNotBlank(fifthGradeEn) || StringUtils.isNotBlank(drugZh) || StringUtils.isNotBlank(drugEn)) {
                String fifthStr = fifthGradeZh + fifthGradeEn + drugZh + drugEn;
                // 存在五级

                fifthCode = fourthCode + "." + (random.nextInt(900) + 100);
                codeMap5.put(fifthStr, fifthCode);
                List<String> nameList = new ArrayList<>();
                List<String> normalNameList = new ArrayList<>();
                if (StringUtils.isNotBlank(fifthGradeZh)) {
                    nameList.add(fifthGradeZh);
                    normalNameList.add(fifthGradeZh);
                }
                if (StringUtils.isNotBlank(fifthGradeEn)) {
                    nameList.add(fifthGradeEn);
                    normalNameList.add(fifthGradeEn);
                }
                if (StringUtils.isNotBlank(drugZh)) {
                    nameList.add(drugZh);
                }
                if (StringUtils.isNotBlank(drugEn)) {
                    nameList.add(drugEn);
                }
                GradeAndDrugs gradeAndDrugs = new GradeAndDrugs(UUID.randomUUID().toString(), nameList, normalNameList, fifthCode, 4, type);
                list.add(gradeAndDrugs);
                continue;

            }
            num++;
            if (num % 100 == 0) {
                log.info("当前处理进度为[{}/{}]", num, readAll.size());
            }
        }
        mongoTemplate.insert(list, GradeAndDrugs.class);
        log.info("药品等级与药品名称写入完成，用时[{}]", System.currentTimeMillis() - startTime);
    }

    @Override
    public void insertToIndex() {
        long count = mongoTemplate.count(new Query(), DrugAndIndication.class);
        int pageSize = 500;
        int num = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);
        log.info("药品适应症数据共[{}]条，共需要写入[{}]次", count, num);
        for (int i = 0; i < num; i++) {
            List<DrugAndIndicationIndex> list = new ArrayList<>();
            Query query = new Query();
            query.with(PageRequest.of(i, pageSize));
            List<DrugAndIndication> drugAndIndications = mongoTemplate.find(query, DrugAndIndication.class);
            for (DrugAndIndication drugAndIndication : drugAndIndications) {
                DrugAndIndicationIndex drugAndIndicationIndex = new DrugAndIndicationIndex();
                // id
                drugAndIndicationIndex.setId(drugAndIndication.getId());
                // 药品名称
                String drugName = drugAndIndication.getDrugName();
                drugAndIndicationIndex.setZhDrugName(drugName);
                List<String> drugNames = new ArrayList<>();
                drugNames.add(drugName);
                // 药品英文名称
                String englishDrugName = drugAndIndication.getEnglishDrugName();
                if (StringUtils.isNotBlank(englishDrugName)) {
                    drugNames.add(englishDrugName);
                }
                drugAndIndicationIndex.setDrugName(drugNames);
                List<String> disease = new ArrayList<>();
                // 中文疾病名称
                List<String> diseaseZh = drugAndIndication.getDiseaseZh();
                if (CollUtil.isNotEmpty(diseaseZh)) {
                    disease.addAll(diseaseZh);
                }
                // 英文疾病名称
                List<String> diseaseEn = drugAndIndication.getDiseaseEn();
                if (CollUtil.isNotEmpty(diseaseEn)) {
                    disease.addAll(diseaseEn);
                }
                // 疾病同义词名称
                List<String> diseaseSynonym = drugAndIndication.getDiseaseSynonym();
                if (CollUtil.isNotEmpty(diseaseSynonym)) {
                    disease.addAll(diseaseSynonym);
                }
                // 增加中英文对照拼接词
                List<String> zhAndEn = new ArrayList<>();
//                if (CollUtil.isNotEmpty(diseaseZh)){
//                    for (int i1 = 0; i1 < diseaseZh.size(); i1++) {
//                        String zh = diseaseZh.get(i1);
//                        if (i1 < diseaseEn.size()) {
//                            String en = diseaseEn.get(i1);
//                            zhAndEn.add(zh + "=" + en);
//                        }else {
//                            zhAndEn.add(zh);
//                        }
//                    }
//                }
                drugAndIndicationIndex.setZhAndEn(zhAndEn);
                drugAndIndicationIndex.setDisease(disease);
                // 适应症
                String indication = drugAndIndication.getIndication();
                if (StringUtils.isNotBlank(indication)) {
                    drugAndIndicationIndex.setIndication(indication);
                }
                // 药品厂家
                String manufacturer = drugAndIndication.getManufacturer();
                if (StringUtils.isNotBlank(manufacturer)) {
                    drugAndIndicationIndex.setManufacturer(manufacturer);
                }
                list.add(drugAndIndicationIndex);
            }
            elasticsearchRestTemplate.save(list);
            log.info("第[{}]次写入完成", i);
        }
        log.info("全部写入完成");
    }

    @Override
    public void insertDrugPrice() {
        long startTime = System.currentTimeMillis();
        ExcelReader reader = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\药品+价格+是否医保+是否基药-20230711(1)(1).xlsx"), 0);
        List<Map<String, Object>> readAll = reader.readAll();
        log.info("共查询出药品价格数量为[{}]", readAll.size());
        List<DrugAndPrice> list = new ArrayList<>();
        // 记录数据处理进程
        int num = 0;
        for (Map<String, Object> map : readAll) {
            DrugAndPrice drugAndPrice = new DrugAndPrice();
            // id
            drugAndPrice.setId(UUID.randomUUID().toString());
            // 药品名称
            String drugName = map.get("药品名称").toString();
            drugAndPrice.setDrugName(drugName);
            // 产品名称
            String productName = map.get("产品名称") != null ? map.get("产品名称").toString() : "";
            drugAndPrice.setProductName(productName);
            // 中文通用名
            String commonName = map.get("中文通用名") != null ? map.get("中文通用名").toString() : "";
            drugAndPrice.setCommonName(commonName);
            // 药品规格
            String specifications = map.get("药品规格") != null ? map.get("药品规格").toString() : "";
            drugAndPrice.setSpecifications(specifications);
            // 转换比
            String conversionRate = map.get("转换比") != null ? map.get("转换比").toString() : "";
            drugAndPrice.setConversionRate(conversionRate);
            // 药品剂型
            String dosageForm = map.get("药品剂型") != null ? map.get("药品剂型").toString() : "";
            drugAndPrice.setDosageForm(dosageForm);
            // 药品厂家
            String manufacturer = map.get("生产企业") != null ? map.get("生产企业").toString() : "";
            drugAndPrice.setManufacturer(manufacturer);
            // 中标价格
            String bidWinningPrice = map.get("中标价") != null ? map.get("中标价").toString() : "";
            drugAndPrice.setBidWinningPrice(bidWinningPrice);
            // 支付类型
            String paymentType = map.get("支付类型") != null ? map.get("支付类型").toString() : "";
            drugAndPrice.setPaymentType(paymentType);
            // 支付范围
            String paymentScope = map.get("限定支付范围") != null ? map.get("限定支付范围").toString() : "";
            drugAndPrice.setPaymentScope(paymentScope);
            // 是否是国家基本药物
            String essentialMedicines = map.get("是否基药") != null ? map.get("是否基药").toString() : "";
            drugAndPrice.setEssentialMedicines(essentialMedicines);
            list.add(drugAndPrice);
            num++;
            if (num % 100 == 0) {
                log.info("当前处理进度为[{}/{}]", num, readAll.size());
            }
        }
        mongoTemplate.insert(list, DrugAndPrice.class);
        log.info("药品价格写入完成，用时[{}]", System.currentTimeMillis() - startTime);
    }

    @Override
    public void changeDrugIndicationDataForm() {
        int pageSize = 1000;
        long count = mongoTemplate.count(new Query(), JSONObject.class, "evaluation_manual_indications");
        int pageNum = (int) (count % pageSize == 0 ? count / pageSize : count / pageSize + 1);
        List<DrugAndIndication> list = new ArrayList<>();
        for (int i = 0; i < pageNum; i++) {
            Query query = new Query();
            query.with(PageRequest.of(i, pageSize));
            List<JSONObject> objectList = mongoTemplate.find(query, JSONObject.class, "evaluation_manual_indications");
            for (JSONObject jsonObject : objectList) {
                DrugAndIndication drugAndIndication = new DrugAndIndication();
                drugAndIndication.setId(UUID.randomUUID().toString());
                // generic_name 药品名称
                String genericName = jsonObject.getString("generic_name");
                if (StringUtils.isNotBlank(genericName)) {
                    drugAndIndication.setDrugName(genericName);
                }
                // english_name 药品英文名称
                String englishName = jsonObject.getString("english_name");
                if (StringUtils.isNotBlank(englishName)) {
                    drugAndIndication.setEnglishDrugName(englishName);
                }
                // enterprise_name 生产厂家
                String enterpriseName = jsonObject.getString("enterprise_name");
                if (StringUtils.isNotBlank(enterpriseName)) {
                    drugAndIndication.setManufacturer(enterpriseName);
                }
                // specifications 规格
                String specifications = jsonObject.getString("specifications");
                if (StringUtils.isNotBlank(specifications)) {
                    drugAndIndication.setSpecifications(specifications);
                }
                // indication 适应症
                String indication = jsonObject.getString("indication");
                if (StringUtils.isNotBlank(indication)) {
                    drugAndIndication.setIndication(indication);
                }
                // indications
                JSONArray indications = jsonObject.getJSONArray("indications");
                List<String> diseaseList = new ArrayList<>();
                List<String> diseaseEnList = new ArrayList<>();
                List<String> synonymsList = new ArrayList<>();
                List<String> treatmentList = new ArrayList<>();
                for (int i1 = 0; i1 < indications.size(); i1++) {
                    JSONObject object = indications.getJSONObject(i1);
                    // disease 疾病名称
                    String disease = object.getString("disease");
                    if (StringUtils.isNotBlank(disease)) {
                        diseaseList.add(disease);
                    }
                    // disease_en 疾病英文名称
                    String diseaseEn = object.getString("disease_en");
                    if (StringUtils.isNotBlank(diseaseEn)) {
                        diseaseEnList.add(diseaseEn);
                    }
                    // synonyms 疾病同义词
                    String synonyms = object.getString("synonyms");
                    if (StringUtils.isNotBlank(synonyms) && !"-".equals(synonyms)) {
                        String[] split = synonyms.split("，");
                        synonymsList.addAll(Arrays.asList(split));
                    }
                    // treatment 治疗方案
                    String treatment = object.getString("treatment");
                    if (StringUtils.isNotBlank(treatment)) {
                        treatmentList.add(treatment);
                    }
                }
                if (CollUtil.isNotEmpty(diseaseList)) {
                    drugAndIndication.setDiseaseZh(diseaseList);
                }
                if (CollUtil.isNotEmpty(diseaseEnList)) {
                    drugAndIndication.setDiseaseEn(diseaseEnList);
                }
                if (CollUtil.isNotEmpty(synonymsList)) {
                    drugAndIndication.setDiseaseSynonym(synonymsList);
                }
                if (CollUtil.isNotEmpty(treatmentList)) {
                    drugAndIndication.setTreatmentPlan(treatmentList);
                }
                list.add(drugAndIndication);
            }
            log.info("第[{}]页写入查询完成", i);
        }
        mongoTemplate.insert(list, DrugAndIndication.class);
        log.info("药品适应症数据写入完成");
    }

    @Override
    public void handleDrugInfo() {
        long startTime = System.currentTimeMillis();
        ExcelReader reader = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\循证综合评价\\药品表（总表）-20231121与美康药理学分类对应-1.xlsx"), 0);
//        ExcelReader reader = ExcelUtil.getReader(FileUtil.file("/Users/yyyyouhf/Desktop/循证综合评价/药品表（总表）-20231212补充药智+用药助手药品说明书.xlsx"), 0);
        List<Map<String, Object>> readAll = reader.readAll();
        log.info("共查询出药品数量为[{}]", readAll.size());
        // mongo
        List<DrugInfo> drugInfos = new ArrayList<>();
        // es
        List<DrugAndIndicationIndex> indexList = new ArrayList<>();
        int num = 0;
        for (Map<String, Object> map : readAll) {
            DrugInfo drugInfo = new DrugInfo();
            DrugAndIndicationIndex index = new DrugAndIndicationIndex();
            String id = UUID.randomUUID().toString();
            drugInfo.setId(id);
            index.setId(id);
            // 药品名称
            if (map.get("产品名称") == null) {
                continue;
            }
            String drugName = map.get("产品名称").toString();
            if (StringUtils.isBlank(drugName)) {
                continue;
            }
            drugInfo.setDrugName(drugName);
            index.setZhDrugName(drugName);
            List<String> symbolList = Arrays.asList("-", "--", "---", "----", "-----", "------", "－－－－", "—", "——", "————", "/");
            // 剂型
            String dosageForm = map.get("剂型") != null ? map.get("剂型").toString() : "";
            if (StringUtils.isNotBlank(dosageForm)) {
                for (String txt : symbolList) {
                    if (txt.equals(dosageForm)) {
                        dosageForm = "";
                        break;
                    }
                }
            }
            index.setDosageForm(dosageForm);
            // 药品厂家
            String manufacturer = map.get("厂家") == null ? "" : map.get("厂家").toString();
            drugInfo.setManufacturer(manufacturer);
            index.setManufacturer(manufacturer);
            // 药品规格
            String specifications = map.get("规格") == null ? "" : map.get("规格").toString();
            for (String txt : symbolList) {
                if (txt.equals(specifications)) {
                    specifications = "";
                    break;
                }
            }
            drugInfo.setSpecifications(specifications);
            index.setSpecifications(specifications);
            // 商品名添加
            String commodityNameZh = map.get("商品名-中文") == null ? "" : map.get("商品名-中文").toString();
            index.setCommodityNameZh(commodityNameZh);
            drugInfo.setCommunityNameZh(commodityNameZh);
            String commodityNameEn = map.get("商品名-英文") == null ? "" : map.get("商品名-英文").toString();
            index.setCommodityNameEn(commodityNameEn);
            drugInfo.setCommunityNameEn(commodityNameEn);
            // es药品检索
            List<String> drugNames = new ArrayList<>();
            List<String> zhDrugNames = new ArrayList<>();
            List<String> enDrugNames = new ArrayList<>();
            // 五级英文
            String drugEn = map.get("五级英文") == null ? "" : map.get("五级英文").toString();
            drugInfo.setDrugEn(drugEn);
            if (StringUtils.isNotBlank(drugEn)) {
                drugNames.add(drugEn);
                enDrugNames.add(drugEn);
            }
            // 五级英文同义词
            List<String> drugSynonymEn = new ArrayList<>();
            String drugSynonymEnStr = map.get("五级英文同义词") == null ? "" : map.get("五级英文同义词").toString();
            if (StringUtils.isNotBlank(drugSynonymEnStr)) {
                String[] split = drugSynonymEnStr.split("卍");
                drugSynonymEn.addAll(Arrays.asList(split));
            }
            drugInfo.setDrugSynonymEn(drugSynonymEn);
            if (CollectionUtil.isNotEmpty(drugSynonymEn)) {
                drugNames.addAll(drugSynonymEn);
            }
            // 五级中文
            String drugZh = map.get("五级中文") == null ? "" : map.get("五级中文").toString();
            drugInfo.setDrugZh(drugZh);
            if (StringUtils.isNotBlank(drugZh)) {
                drugNames.add(drugZh);
                zhDrugNames.add(drugZh);
            }
            // 五级中文同义词
            List<String> drugSynonymZh = new ArrayList<>();
            String drugSynonymZhStr = map.get("五级中文同义词") == null ? "" : map.get("五级中文同义词").toString();
            if (StringUtils.isNotBlank(drugSynonymZhStr)) {
                String[] split = drugSynonymZhStr.split("；");
                drugSynonymZh.addAll(Arrays.asList(split));
            }
            drugInfo.setDrugSynonymZh(drugSynonymZh);
            if (CollectionUtil.isNotEmpty(drugSynonymZh)) {
                drugNames.addAll(drugSynonymZh);
            }
            index.setDrugName(drugNames);
            index.setZhDrugNames(zhDrugNames);
            index.setEnDrugNames(enDrugNames);
            // 医保情况
            String medicalInsurance = map.get("甲乙类").toString().equals("-") ? "" : map.get("甲乙类").toString();
            drugInfo.setMedicalInsurance(medicalInsurance);
            // 支付范围
            String paymentScope = map.get("是否有支付限制") == null ? "" : map.get("是否有支付限制").toString();
            drugInfo.setPaymentScope(paymentScope);
            // 是否是国家基本药物
            String essentialMedicines = map.get("是否基药").toString();
            drugInfo.setEssentialMedicines(essentialMedicines);
            // 是否有△要求
            String essentialType = map.get("是否有△要求") == null ? "" : map.get("是否有△要求").toString();
            drugInfo.setEssentialType(essentialType);
            // 适应症
            String indication = map.get("适应症原文") == null ? "" : map.get("适应症原文").toString();
            drugInfo.setIndication(indication);
            if (StringUtils.isNotBlank(indication)) {
                index.setIndication(indication);
            }
            List<String> disease = new ArrayList<>();
            // 中文疾病名称
            List<String> diseaseZh = new ArrayList<>();
            String diseaseZhStr = map.get("适应症-中文") == null ? "" : map.get("适应症-中文").toString();
            if (StringUtils.isNotBlank(diseaseZhStr)) {
                String[] split = diseaseZhStr.split("###");
                for (String txt : split) {
                    if (!"-".equals(txt)) {
                        diseaseZh.add(txt);
                    }
                }
            }
            drugInfo.setDiseaseZh(diseaseZh);
            index.setDiseaseZh(diseaseZh);
            if (CollectionUtil.isNotEmpty(diseaseZh)) {
                disease.addAll(diseaseZh);
            }
            // 英文疾病名称
            List<String> diseaseEn = new ArrayList<>();
//            String diseaseEnStr = map.get("适应症-英文") == null ? "" : map.get("适应症-英文").toString();
//            if (StringUtils.isNotBlank(diseaseEnStr)){
//                String[] split = diseaseEnStr.split("###");
//                for (String txt : split) {
//                    if (!"-".equals(txt)){
//                        diseaseEn.add(txt);
//                    }
//                }
//            }
            drugInfo.setDiseaseEn(diseaseEn);
            index.setDiseaseEn(diseaseEn);
            if (CollectionUtil.isNotEmpty(diseaseEn)) {
                disease.addAll(diseaseEn);
            }
            // 疾病同义词
            List<String> diseaseSynonym = new ArrayList<>();
//            String diseaseSynonymStr = map.get("适应症-同义词") == null ? "" : map.get("适应症-同义词").toString();
//            if (StringUtils.isNotBlank(diseaseSynonymStr)){
//                String[] split = diseaseSynonymStr.split("###");
//                for (String txt : split) {
//                    if (!"-".equals(txt)){
//                        diseaseSynonym.add(txt);
//                    }
//                }
//            }
            drugInfo.setDiseaseSynonym(diseaseSynonym);
            index.setDisease(disease);
            if (CollectionUtil.isNotEmpty(diseaseSynonym)) {
                disease.addAll(diseaseSynonym);
            }
            // 皮试情况
            String skinTest = map.get("是否需要皮试") == null ? "" : map.get("是否需要皮试").toString();
            drugInfo.setSkinTest(skinTest);
            // 集中采药情况
            String drugCollection = map.get("是否集采药品") == null ? "" : map.get("是否集采药品").toString();
            drugInfo.setDrugCollection(drugCollection);

            // 药学特性部分
            // 药理作用 -- 药理作用
            String pharmacology = map.get("药理作用") == null ? "" : map.get("药理作用").toString();
            drugInfo.setPharmacology(pharmacology);
            // 药代动力学 -- 体内过程
            String pharmacokinetics = map.get("药代动力学") == null ? "" : map.get("药代动力学").toString();
            drugInfo.setPharmacokinetics(pharmacokinetics);
            // 用法用量 -- 药剂学与使用方法
            String usageAndDosage = map.get("用法用量") == null ? "" : map.get("用法用量").toString();
            drugInfo.setUsageAndDosage(usageAndDosage);
            // 贮藏 -- 贮藏条件
            String storage = map.get("贮藏") == null ? "" : map.get("贮藏").toString();
            drugInfo.setStorage(storage);
            // 有效期 -- 有效期
            String indate = map.get("有效期") == null ? "" : map.get("有效期").toString();
            drugInfo.setIndate(indate);

            // 有效性部分
            // 主治/适应症
            String indications = map.get("主治/适应症") == null ? "" : map.get("主治/适应症").toString();
            drugInfo.setIndications(indications);
            if (StringUtils.isNotEmpty(indications)) {
                index.setIndications(indications);
            }

            // 安全性部分
            // 不良反应
            String adverseReaction = map.get("不良反应") == null ? "" : map.get("不良反应").toString();
            drugInfo.setAdverseReaction(adverseReaction);
            // 孕妇及哺乳期妇女
            String pregnantWomen = map.get("孕妇及哺乳期妇女") == null ? "" : map.get("孕妇及哺乳期妇女").toString();
            drugInfo.setPaymentScope(pregnantWomen);
            // 儿童用药
            String childrenMedicine = map.get("儿童用药") == null ? "" : map.get("儿童用药").toString();
            drugInfo.setChildrenMedicine(childrenMedicine);
            // 老年用药
            String geriatricMedicine = map.get("老年用药") == null ? "" : map.get("老年用药").toString();
            drugInfo.setGeriatricMedicine(geriatricMedicine);
            // 药物相互作用
            String drugInteraction = map.get("药物相互作用") == null ? "" : map.get("药物相互作用").toString();
            drugInfo.setGeriatricMedicine(drugInteraction);

            // 其他属性
            // 原研药
            String originalDrug = map.get("原研药") == null ? "" : map.get("原研药").toString();
            drugInfo.setGeriatricMedicine(originalDrug);
            // 参比药品
            String referenceDrug = map.get("参比药品") == null ? "" : map.get("药物相互作用").toString();
            drugInfo.setReferenceDrug(referenceDrug);
            // 一致性评价药品
            String consistencyDrug = map.get("一致性评价") == null ? "" : map.get("一致性评价").toString();
            drugInfo.setConsistencyDrug(consistencyDrug);

            // 成分
            String ingredient = map.get("成分") == null ? "" : map.get("成分").toString();
            drugInfo.setIngredient(ingredient);

            // 增加中英文对照拼接词
            List<String> zhAndEn = new ArrayList<>();
            // 这是之前有适应症英文时候的逻辑
//            if (CollectionUtil.isNotEmpty(diseaseZh)){
//                for (int i1 = 0; i1 < diseaseZh.size(); i1++) {
//                    String zh = diseaseZh.get(i1);
//                    if (i1 < diseaseEn.size()) {
//                        String en = diseaseEn.get(i1);
//                        zhAndEn.add(zh + "=" + en);
//                    }else {
//                        zhAndEn.add(zh);
//                    }
//                }
//            }
            index.setZhAndEn(zhAndEn);
            drugInfos.add(drugInfo);
            indexList.add(index);
            num++;
            if (num % 500 == 0 || num == readAll.size()) {
                log.info("第[{}]写入500条数据", num / 500);
                if (num == readAll.size()) {
                    log.info("写入完成");
                }
                mongoTemplate.insert(drugInfos, DrugInfo.class);
                elasticsearchRestTemplate.save(indexList);
                // mongo
                drugInfos = new ArrayList<>();
                // es
                indexList = new ArrayList<>();
            }
        }
        log.info("共用时[{}]", System.currentTimeMillis() - startTime);
    }


    @Override
    public void importDrugInfo() {
//        String filePath = "/Users/yyyyouhf/Desktop/循证综合评价/药品表（总表）-20231212补充药智+用药助手药品说明书.xlsx";
        String filePath = "/Users/86131/Desktop/灵犀量子/药品表（总表）-20240524(1).xlsx";
        File importFile = new File(filePath);

        com.alibaba.excel.ExcelReader excelReader = null;
        try {
            DrugInfoImportExcelListener listener = new DrugInfoImportExcelListener(drugInfoImportManager);
            excelReader = EasyExcel.read(importFile, DrugInfoExcelBean.class, listener).build();
            ReadSheet readSheet = EasyExcel.readSheet(0).build();
            excelReader.read(readSheet);
        } catch (Exception ex) {
            log.error("Episode Excel Import Exception.", ex);
        } finally {
            log.info("执行完毕excel导入");
            if (Objects.nonNull(excelReader)) {
                excelReader.finish();
            }
            log.info("执行完毕excel导入啦啦啦啦阿拉啦");
        }

    }


    public void generateLianhuaQingwenReport(HttpServletResponse response, String id) throws IOException, DocumentException {
        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "tr_info_score_v2");

        log.info("开始生成{}", id);
        if (jsonObjects != null) {

            response.setCharacterEncoding("UTF-8");
            response.setContentType("application/octet-stream");
            TrInheritanceEvaluationDto inheritanceEvaluation;
            TrClinicalEvaluationDto clinicalEvaluation;
            TrSafetyEvaluationDto safetyEvaluation;
            TrTechnologyEvaluationDto technologyEvaluation;
            TrMarketEvaluationDto marketEvaluation;
            TrInfoDto trInfoDto = JSONObject.parseObject(jsonObjects.toJSONString(), TrInfoDto.class);
            inheritanceEvaluation = trInfoDto.getTrInheritanceEvaluationDto();
            clinicalEvaluation = trInfoDto.getTrClinicalEvaluationDto();
            safetyEvaluation = trInfoDto.getTrSafetyEvaluationDto();
            technologyEvaluation = trInfoDto.getTrTechnologyEvaluationDto();
            marketEvaluation = trInfoDto.getTrMarketEvaluationDto();
            String drugInfo = trInfoDto.getTitle();

            response.setHeader("Content-Disposition", "attachment;fileName=" + jsonObjects.getString("simpleTitle") + ".doc");
            ServletOutputStream outputStream = response.getOutputStream();
            Document document = new Document();
            document.setPageSize(com.lowagie.text.PageSize.A4);
            document.setMargins(50, 50, 50, 50);

            RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
            document.open();

            ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
            InputStream inputStreamImg = classPathResource.getInputStream();
            byte[] bytes = IOUtils.toByteArray(inputStreamImg);
            com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
            logo.scaleAbsolute(100, 30);
            logo.setAlignment(Image.ALIGN_RIGHT);

            Paragraph headerParagraph = new Paragraph();
            headerParagraph.add(logo);
            headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

            HeaderFooter header = new HeaderFooter(headerParagraph, false);
            header.setAlignment(HeaderFooter.ALIGN_RIGHT);
            header.setBorderWidth(0);

            document.setHeader(header);

            Paragraph paragraphTitle = createDataWordV1(jsonObjects.getString("simpleTitle"));
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
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);

            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);

            // 新开一页
            document.newPage();

            // 摘要
            // 摘要
            Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            document.add(abstractTitle);
            Paragraph abstractContent = new Paragraph("目的 根据《河北省公立医疗机构中成药遴选评价表》对" + drugInfo + "进行临床综合评价。方法 该中成药遴选量表通过对传承评价（22分）、临床评价（25分）、安全评价（20分）、技术评价（14分）及市场评价（19分）5个方面内容，对药品进行临床综合评价归纳总结。结果 根据《河北省公立医疗机构中成药遴选评价表》：" + drugInfo + "最终得分为" + doubleToString(trInfoDto.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(abstractContent);

            // 评价目的
            Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
            // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(purposeTitle);
            Paragraph purposeContent = new Paragraph("本研究通过传承评价、临床评价、安全评价、技术评价以及市场评价5个评价维度，进行量化打分，以期对进出医疗机构的中成药进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(purposeContent);

            // 评价药品
            Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(drugTitle);
            Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
            document.add(drugContent);

            // 评价过程
            Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(processTitle);
            Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《河北省公立医疗机构中成药遴选评价表》进行量化打分，其评估维度包括传承评价、临床评价、安全评价、技术评价以及市场评价。总分加和为100分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(processContent);

            // 评价结果
            Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(resultTitle);
            Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + doubleToString(trInfoDto.getTotalScore()) + "分，其中传承评价最终得分" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分，临床评价最终得分" + doubleToString(clinicalEvaluation.getTotalScore()) + "分，安全评价最终得分" + doubleToString(safetyEvaluation.getTotalScore()) + "分，技术评价最终得分" + doubleToString(technologyEvaluation.getTotalScore()) + "分，市场评价最终得分" + doubleToString(marketEvaluation.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(totalScoreParagraph);

            // 药学特性
            Paragraph pharmaceuticalTitle = new Paragraph("1、传承评价（共22分，得分：" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            pharmaceuticalTitle.setSpacingBefore(10);
            pharmaceuticalTitle.setSpacingAfter(10);
            document.add(pharmaceuticalTitle);
            addSubItem(document, "1.1 组方来源", inheritanceEvaluation.getRecipeSourceContent(), inheritanceEvaluation.getRecipeSourceScore());
            addSubItemTitle(document, "1.2 理论支撑", inheritanceEvaluation.getTheorySupportScore());
            addSubItem(document, "1.2.1 中医药理论指导", inheritanceEvaluation.getTheoryGuidanceContent(), inheritanceEvaluation.getTheoryGuidanceScore());
            addSubItem(document, "1.2.2 君臣佐使配伍", inheritanceEvaluation.getTheoryCombinationContent(), inheritanceEvaluation.getTheoryCombinationScore());
            addSubItem(document, "1.2.3 君臣药的药性、归经与治疗目标是否相符", inheritanceEvaluation.getTheoryPathogenesisContent(), inheritanceEvaluation.getTheoryPathogenesisScore());
            addSubItem(document, "1.2.4 君臣药的炮制品选择与治疗目标是否相符", inheritanceEvaluation.getTheoryPotContent(), inheritanceEvaluation.getTheoryPotScore());


            addSubItemTitle(document, "1.3 病证结合", inheritanceEvaluation.getDiseaseCombinationScore());
            addSubItem(document, "1.3.1 疾病、证候、症状描述", inheritanceEvaluation.getDiseaseCombinationContent1(), inheritanceEvaluation.getDiseaseCombinationScore1());
            addSubItem(document, "1.3.2 疾病使用西医术语描述", inheritanceEvaluation.getDiseaseCombinationContent2(), inheritanceEvaluation.getDiseaseCombinationScore2());

            // 临床评价
            Paragraph clinicalTitle = new Paragraph("2、临床评价（共25分，得分：" + doubleToString(clinicalEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            clinicalTitle.setSpacingBefore(10);
            clinicalTitle.setSpacingAfter(10);
            document.add(clinicalTitle);
            addSubItem(document, "2.1 临床定位", clinicalEvaluation.getClinicalPositioningContent(), clinicalEvaluation.getClinicalPositioningScore());
            addSubItem(document, "2.2 临床研究", clinicalEvaluation.getClinicalResearchContent(), clinicalEvaluation.getClinicalResearchScore());
            addSubItem(document, "2.3 证据推荐", getEvidenceRecommendationContent(clinicalEvaluation), clinicalEvaluation.getEvidenceRecommendationScore());
            addSubItem(document, "2.4 临床需求", clinicalEvaluation.getClinicalDemandOption(), clinicalEvaluation.getClinicalDemandScore());

            // 安全评价
            Paragraph safetyTitle = new Paragraph("3、安全评价（共20分，得分：" + doubleToString(safetyEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            safetyTitle.setSpacingBefore(10);
            safetyTitle.setSpacingAfter(10);
            document.add(safetyTitle);
            // 安全信息评价
            Paragraph safetyInfoTitle = createHeadWord(12, "3.1 安全信息评价（" + doubleToString(safetyEvaluation.getSafetyInfoScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.1安全信息评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            safetyInfoTitle.setSpacingBefore(10);
            safetyInfoTitle.setSpacingAfter(10);
            document.add(safetyInfoTitle);
            addSubSubItem(document, "3.1.1 不良反应、禁忌等描述", safetyEvaluation.getAdverseReactionContent(), safetyEvaluation.getAdverseReactionScore());
            addSubSubItem(document, "3.1.2 说明书中警示语或注意事项", safetyEvaluation.getWarningNoteContent(), safetyEvaluation.getWarningNoteScore());
            addSubSubItem(document, "3.1.3 辅料", String.valueOf(safetyEvaluation.getExcipient()), safetyEvaluation.getExcipientScore());
            addSubSubItem(document, "3.1.4 安全性再评价", safetyEvaluation.getSafetyReevaluationContent(), safetyEvaluation.getSafetyReevaluationScore());
            // 人群限制
            Paragraph populationRestrictionTitle = createHeadWord(12, "3.2 人群限制（" + doubleToString(safetyEvaluation.getCrowdRestrictionScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.2人群限制（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            populationRestrictionTitle.setSpacingBefore(10);
            populationRestrictionTitle.setSpacingAfter(10);
            document.add(populationRestrictionTitle);
            addSubSubItem(document, "3.2.1 儿童用药", safetyEvaluation.getPediatricDrugUseContent(), safetyEvaluation.getPediatricDrugUseScore());
            addSubSubItem(document, "3.2.2 妊娠期妇女用药", safetyEvaluation.getPregnancyDrugUseContent(), safetyEvaluation.getPregnancyDrugUseScore());
            addSubSubItem(document, "3.2.3 哺乳期妇女用药", safetyEvaluation.getLactationDrugUseContent(), safetyEvaluation.getLactationDrugUseScore());
            addSubSubItem(document, "3.2.4 肝功能异常者用药", safetyEvaluation.getLiverDysfunctionDrugUseContent(), safetyEvaluation.getLiverDysfunctionDrugUseScore());
            addSubSubItem(document, "3.2.5 肾功能异常者用药", safetyEvaluation.getKidneyDysfunctionDrugUseContent(), safetyEvaluation.getKidneyDysfunctionDrugUseScore());
            addSubSubItem(document, "3.2.6 运动员用药", safetyEvaluation.getAthleteDrugUseContent(), safetyEvaluation.getAthleteDrugUseScore());
            // 不良反应分级
            addSubItem(document, "3.3 不良反应分级", safetyEvaluation.getAdverseReactionStratificationContent(), safetyEvaluation.getAdverseReactionStratificationScore());

            // 技术评价
            Paragraph technologyTitle = createHeadWord(14, "4、技术评价（共14分，得分：" + doubleToString(technologyEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT); // new Paragraph("4、技术评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            technologyTitle.setSpacingBefore(10);
            technologyTitle.setSpacingAfter(10);
            document.add(technologyTitle);
            // 适宜性
            Paragraph suitabilityTitle = createHeadWord(12, "4.1 适宜性（" + doubleToString(technologyEvaluation.getSuitabilityScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("4.1适宜性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            suitabilityTitle.setSpacingBefore(10);
            suitabilityTitle.setSpacingAfter(10);
            document.add(suitabilityTitle);
            addSubSubItem(document, "4.1.1 给药频次", technologyEvaluation.getAdministrationFrequencyContent(), technologyEvaluation.getAdministrationFrequencyScore());
            addSubSubItem(document, "4.1.2 包装规格", technologyEvaluation.getPackagingSpecificationOption(), technologyEvaluation.getPackagingSpecificationScore());
            addSubSubItem(document, "4.1.3 采用大包装", technologyEvaluation.getLargePackageAdoptionOption(), technologyEvaluation.getLargePackageAdoptionScore());
            addSubSubItem(document, "4.1.4 单次用量", technologyEvaluation.getSingleDoseOption(), technologyEvaluation.getSingleDoseScore());
            addSubSubItem(document, "4.1.5 疗程", technologyEvaluation.getCourseOfTreatmentContent(), technologyEvaluation.getCourseOfTreatmentScore());
            addSubSubItem(document, "4.1.6 贮藏", technologyEvaluation.getStorageContent(), technologyEvaluation.getStorageScore());
            addSubSubItem(document, "4.1.7 有效期", String.valueOf(technologyEvaluation.getValidityPeriodContent()), technologyEvaluation.getValidityPeriodScore());
            addSubItem(document, "4.2 国家中药保护品种", String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), technologyEvaluation.getNationalTraditionalChineseMedicineProtectionScore());
            // 附加属性
            Paragraph additionalAttributesTitle = createHeadWord(12, "4.3 附加属性（" + doubleToString(technologyEvaluation.getAdditionalZodiacScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("4.3附加属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            additionalAttributesTitle.setSpacingBefore(10);
            additionalAttributesTitle.setSpacingAfter(10);
            document.add(additionalAttributesTitle);
            addSubSubItem(document, "4.3.1 中国药典", String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), technologyEvaluation.getChinesePharmacopoeiaScore());
            addSubSubItem(document, "4.3.2 专利", technologyEvaluation.getPatentNumber(), technologyEvaluation.getPatentScore());
            addSubSubItem(document, "4.3.3 独家品种", technologyEvaluation.getExclusiveVarietyInfo(), technologyEvaluation.getExclusiveVarietyScore());

            // 市场评价
            Paragraph marketTitle = createHeadWord(14, "5、市场评价（共19分，得分：" + doubleToString(marketEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT);// new Paragraph("5、市场评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            marketTitle.setSpacingBefore(10);
            marketTitle.setSpacingAfter(10);
            document.add(marketTitle);
            addSubItem(document, "5.1 市场独特性", marketEvaluation.getMarketUniquenessOption(), marketEvaluation.getMarketUniquenessScore());
            // 单独加一横
            if (StringUtils.isNotEmpty(marketEvaluation.getMarketUniquenessContent())) {
                Paragraph marketUniquenessInfo = createDataWord("原因：" + marketEvaluation.getMarketUniquenessContent());
                document.add(marketUniquenessInfo);
            }
            addSubItemTitle(document, "5.2 经济性", marketEvaluation.getEconomicScore());
            addSubItem(document, "5.2.1 日均治疗费用", marketEvaluation.getDailyTreatmentCostOption(), marketEvaluation.getDailyTreatmentCostScore());
            addSubItem(document, "5.2.2 经济学优势", getEvidenceRecommendationContentByJson(jsonObjects.getJSONObject("trMarketEvaluationDto").getJSONArray("economicAdvantageOption")), marketEvaluation.getEconomicAdvantageScore());

            // 政策属性
            Paragraph policyAttributeTitle = createHeadWord(12, "5.3 政策属性（" + doubleToString(marketEvaluation.getPolicyAttributeScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("5.3政策属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            policyAttributeTitle.setSpacingBefore(10);
            policyAttributeTitle.setSpacingAfter(10);
            document.add(policyAttributeTitle);
            addSubSubItem(document, "5.3.1 国家基本药物", marketEvaluation.getNationalEssentialDrugsRequirement(), marketEvaluation.getNationalEssentialDrugsScore());
            addSubSubItem(document, "5.3.2 国家医保药品", marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), marketEvaluation.getNationalMedicalInsuranceDrugsScore());
            addSubSubItem(document, "5.3.3 集中带量采购药品或国家谈判品种（协议期内）", marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), marketEvaluation.getCentralizedVolumePurchasingDrugsScore());
            addSubItemTitle(document, "5.4 生产企业状况", marketEvaluation.getProductionEnterpriseStatusScore());
            addSubItem(document, "5.4.1 生产企业", marketEvaluation.getProductionEnterpriseContent(), marketEvaluation.getProductionEnterpriseScore());
            addSubItem(document, "5.4.2 独立的GAP种植基地或全流程质量可追溯体系", marketEvaluation.getOwnPlantingBaseOption(), marketEvaluation.getOwnPlantingBaseScore());

            document.close();
        } else {
            generateLianhuaQingwenReportPc(response, id);
        }
    }


    public void generateLianhuaQingwenReportPc(HttpServletResponse response, String id) throws IOException, DocumentException {
        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "drug_score_tra");

        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        TrInheritanceEvaluationDto inheritanceEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrInheritanceEvaluationDto.class);
        TrClinicalEvaluationDto clinicalEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrClinicalEvaluationDto.class);
        TrSafetyEvaluationDto safetyEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrSafetyEvaluationDto.class);
        TrTechnologyEvaluationDto technologyEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrTechnologyEvaluationDto.class);
        TrMarketEvaluationDto marketEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrMarketEvaluationDto.class);
        TrInfoDto trInfoDto = new TrInfoDto();
        trInfoDto.setTrInheritanceEvaluationDto(inheritanceEvaluation);
        trInfoDto.setTrClinicalEvaluationDto(clinicalEvaluation);
        trInfoDto.setTrSafetyEvaluationDto(safetyEvaluation);
        trInfoDto.setTrTechnologyEvaluationDto(technologyEvaluation);
        trInfoDto.setTrMarketEvaluationDto(marketEvaluation);

        trInfoDto.getTrClinicalEvaluationDto().setTotalScore();
        trInfoDto.getTrMarketEvaluationDto().setPolicyAttributeScore();
        trInfoDto.getTrMarketEvaluationDto().setTotalScore();
        trInfoDto.getTrInheritanceEvaluationDto().setTotalScore();
        trInfoDto.getTrSafetyEvaluationDto().setCrowdRestrictionScore();
        trInfoDto.getTrSafetyEvaluationDto().setSafetyInfoScore();
        trInfoDto.getTrSafetyEvaluationDto().setTotalScore();
        trInfoDto.getTrTechnologyEvaluationDto().setSuitabilityScore();
        trInfoDto.getTrTechnologyEvaluationDto().setAdditionalZodiacScore();
        trInfoDto.getTrTechnologyEvaluationDto().setTotalScore();
        trInfoDto.setTotalScore();

        trInfoDto.setTitle(jsonObjects.getString("title"));
        trInfoDto.setDrugName(jsonObjects.getString("drugInfo"));

        String drugInfo = trInfoDto.getTitle();

        response.setHeader("Content-Disposition", "attachment;fileName=" + jsonObjects.getString("simpleTitle") + ".doc");
        ServletOutputStream outputStream = response.getOutputStream();
        Document document = new Document();
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        document.open();

        ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
        logo.scaleAbsolute(100, 30);
        logo.setAlignment(Image.ALIGN_RIGHT);

        Paragraph headerParagraph = new Paragraph();
        headerParagraph.add(logo);
        headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

        HeaderFooter header = new HeaderFooter(headerParagraph, false);
        header.setAlignment(HeaderFooter.ALIGN_RIGHT);
        header.setBorderWidth(0);

        document.setHeader(header);

        Paragraph paragraphTitle = createDataWordV1(jsonObjects.getString("simpleTitle"));
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
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
        String formattedDate = sdf.format(calendar.getTime());

        Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
        headWord2.setAlignment(Element.ALIGN_CENTER);
        headWord2.setSpacingBefore(9);
        headWord2.setSpacingAfter(8);
        document.add(headWord2);

        Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
        headWord3.setSpacingBefore(9);
        document.add(headWord3);

        // 新开一页
        document.newPage();

        // 摘要
        Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        document.add(abstractTitle);
        Paragraph abstractContent = new Paragraph("目的 根据《河北省公立医疗机构中成药遴选评价表》对" + drugInfo + "进行临床综合评价。方法 该中成药遴选量表通过对传承评价（22分）、临床评价（25分）、安全评价（20分）、技术评价（18分）及市场评价（15分）5个方面内容，对药品进行临床综合评价归纳总结。结果 根据《河北省公立医疗机构中成药遴选评价表》：" + drugInfo + "最终得分为" + doubleToString(trInfoDto.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(abstractContent);

        // 评价目的
        Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
        // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(purposeTitle);
        Paragraph purposeContent = new Paragraph("本研究通过传承评价、临床评价、安全评价、技术评价以及市场评价5个评价维度，进行量化打分，以期对进出医疗机构的中成药进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(purposeContent);

        // 评价药品
        Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(drugTitle);
        Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
        document.add(drugContent);

        // 评价过程
        Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(processTitle);
        Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《河北省公立医疗机构中成药遴选评价表》进行量化打分，其评估维度包括传承评价、临床评价、安全评价、技术评价以及市场评价。总分加和为100分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(processContent);

        // 评价结果
        Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(resultTitle);
        Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + doubleToString(trInfoDto.getTotalScore()) + "分，其中传承评价最终得分" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分，临床评价最终得分" + doubleToString(clinicalEvaluation.getTotalScore()) + "分，安全评价最终得分" + doubleToString(safetyEvaluation.getTotalScore()) + "分，技术评价最终得分" + doubleToString(technologyEvaluation.getTotalScore()) + "分，市场评价最终得分" + doubleToString(marketEvaluation.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(totalScoreParagraph);

        // 药学特性
        Paragraph pharmaceuticalTitle = new Paragraph("1、传承评价（共22分，得分：" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        pharmaceuticalTitle.setSpacingBefore(10);
        pharmaceuticalTitle.setSpacingAfter(10);
        document.add(pharmaceuticalTitle);
        addSubItem(document, "1.1 组方来源", inheritanceEvaluation.getRecipeSourceContent(), inheritanceEvaluation.getRecipeSourceScore());
        addSubItem(document, "1.2 理论支撑", inheritanceEvaluation.getTheorySupportContent(), inheritanceEvaluation.getTheorySupportScore());
        addSubItem(document, "1.3 病证结合", inheritanceEvaluation.getDiseaseCombinationContent(), inheritanceEvaluation.getDiseaseCombinationScore());

        // 临床评价
        Paragraph clinicalTitle = new Paragraph("2、临床评价（共25分，得分：" + doubleToString(clinicalEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        clinicalTitle.setSpacingBefore(10);
        clinicalTitle.setSpacingAfter(10);
        document.add(clinicalTitle);
        addSubItem(document, "2.1 临床定位", clinicalEvaluation.getClinicalPositioningContent(), clinicalEvaluation.getClinicalPositioningScore());
        addSubItem(document, "2.2 临床研究", clinicalEvaluation.getClinicalResearchContent(), clinicalEvaluation.getClinicalResearchScore());
        addSubItem(document, "2.3 证据推荐", getEvidenceRecommendationContent(clinicalEvaluation), clinicalEvaluation.getEvidenceRecommendationScore());
        addSubItem(document, "2.4 临床需求", clinicalEvaluation.getClinicalDemandOption(), clinicalEvaluation.getClinicalDemandScore());

        // 安全评价
        Paragraph safetyTitle = new Paragraph("3、安全评价（共20分，得分：" + doubleToString(safetyEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        safetyTitle.setSpacingBefore(10);
        safetyTitle.setSpacingAfter(10);
        document.add(safetyTitle);
        // 安全信息评价
        Paragraph safetyInfoTitle = createHeadWord(12, "3.1 安全信息评价（" + doubleToString(safetyEvaluation.getSafetyInfoScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.1安全信息评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        safetyInfoTitle.setSpacingBefore(10);
        safetyInfoTitle.setSpacingAfter(10);
        document.add(safetyInfoTitle);
        addSubSubItem(document, "3.1.1 不良反应、禁忌等描述", safetyEvaluation.getAdverseReactionContent(), safetyEvaluation.getAdverseReactionScore());
        addSubSubItem(document, "3.1.2 说明书中警示语或注意事项", safetyEvaluation.getWarningNoteContent(), safetyEvaluation.getWarningNoteScore());
        addSubSubItem(document, "3.1.3 辅料", String.valueOf(safetyEvaluation.getExcipient()), safetyEvaluation.getExcipientScore());
        addSubSubItem(document, "3.1.4 安全性再评价", safetyEvaluation.getSafetyReevaluationContent(), safetyEvaluation.getSafetyReevaluationScore());
        // 人群限制
        Paragraph populationRestrictionTitle = createHeadWord(12, "3.2 人群限制（" + doubleToString(safetyEvaluation.getCrowdRestrictionScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.2人群限制（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        populationRestrictionTitle.setSpacingBefore(10);
        populationRestrictionTitle.setSpacingAfter(10);
        document.add(populationRestrictionTitle);
        addSubSubItem(document, "3.2.1 儿童用药", safetyEvaluation.getPediatricDrugUseContent(), safetyEvaluation.getPediatricDrugUseScore());
        addSubSubItem(document, "3.2.2 妊娠期妇女用药", safetyEvaluation.getPregnancyDrugUseContent(), safetyEvaluation.getPregnancyDrugUseScore());
        addSubSubItem(document, "3.2.3 哺乳期妇女用药", safetyEvaluation.getLactationDrugUseContent(), safetyEvaluation.getLactationDrugUseScore());
        addSubSubItem(document, "3.2.4 肝功能异常者用药", safetyEvaluation.getLiverDysfunctionDrugUseContent(), safetyEvaluation.getLiverDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.5 肾功能异常者用药", safetyEvaluation.getKidneyDysfunctionDrugUseContent(), safetyEvaluation.getKidneyDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.6 运动员用药", safetyEvaluation.getAthleteDrugUseContent(), safetyEvaluation.getAthleteDrugUseScore());
        // 不良反应分级
        addSubItem(document, "3.3 不良反应分级", safetyEvaluation.getAdverseReactionStratificationContent(), safetyEvaluation.getAdverseReactionStratificationScore());

        // 技术评价
        Paragraph technologyTitle = createHeadWord(14, "4、技术评价（共18分，得分：" + doubleToString(technologyEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT); // new Paragraph("4、技术评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        technologyTitle.setSpacingBefore(10);
        technologyTitle.setSpacingAfter(10);
        document.add(technologyTitle);
        // 适宜性
        Paragraph suitabilityTitle = createHeadWord(12, "4.1 适宜性（" + doubleToString(technologyEvaluation.getSuitabilityScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("4.1适宜性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        suitabilityTitle.setSpacingBefore(10);
        suitabilityTitle.setSpacingAfter(10);
        document.add(suitabilityTitle);
        addSubSubItem(document, "4.1.1 给药频次", technologyEvaluation.getAdministrationFrequencyContent(), technologyEvaluation.getAdministrationFrequencyScore());
        addSubSubItem(document, "4.1.2 包装规格", technologyEvaluation.getPackagingSpecificationOption(), technologyEvaluation.getPackagingSpecificationScore());
        addSubSubItem(document, "4.1.3 采用大包装", technologyEvaluation.getLargePackageAdoptionOption(), technologyEvaluation.getLargePackageAdoptionScore());
        addSubSubItem(document, "4.1.4 单次用量", technologyEvaluation.getSingleDoseOption(), technologyEvaluation.getSingleDoseScore());
        addSubSubItem(document, "4.1.5 疗程", technologyEvaluation.getCourseOfTreatmentContent(), technologyEvaluation.getCourseOfTreatmentScore());
        addSubSubItem(document, "4.1.6 贮藏", technologyEvaluation.getStorageContent(), technologyEvaluation.getStorageScore());
        addSubSubItem(document, "4.1.7 有效期", String.valueOf(technologyEvaluation.getValidityPeriodContent()), technologyEvaluation.getValidityPeriodScore());
        addSubItem(document, "4.2 国家中药保护品种", String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), technologyEvaluation.getNationalTraditionalChineseMedicineProtectionScore());
        // 附加属性
        Paragraph additionalAttributesTitle = createHeadWord(12, "4.3 附加属性（" + doubleToString(technologyEvaluation.getAdditionalZodiacScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("4.3附加属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        additionalAttributesTitle.setSpacingBefore(10);
        additionalAttributesTitle.setSpacingAfter(10);
        document.add(additionalAttributesTitle);
        addSubSubItem(document, "4.3.1 中国药典", String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), technologyEvaluation.getChinesePharmacopoeiaScore());
        addSubSubItem(document, "4.3.2 专利", technologyEvaluation.getPatentNumber(), technologyEvaluation.getPatentScore());
        addSubSubItem(document, "4.3.3 独家品种", technologyEvaluation.getExclusiveVarietyInfo(), technologyEvaluation.getExclusiveVarietyScore());
        addSubItem(document, "4.4 生产企业状况", String.valueOf(technologyEvaluation.getProductionEnterpriseStatusContent()), technologyEvaluation.getProductionEnterpriseStatusScore());

        // 市场评价
        Paragraph marketTitle = createHeadWord(18, "5、市场评价（共15分，得分：" + doubleToString(marketEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT);// new Paragraph("5、市场评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        marketTitle.setSpacingBefore(10);
        marketTitle.setSpacingAfter(10);
        document.add(marketTitle);
        addSubItem(document, "5.1 市场独特性", marketEvaluation.getMarketUniquenessOption(), marketEvaluation.getMarketUniquenessScore());
        addSubItem(document, "5.2 经济性", marketEvaluation.getEconomicOption(), marketEvaluation.getEconomicScore());
        // 政策属性
        Paragraph policyAttributeTitle = createHeadWord(12, "5.3 政策属性（" + doubleToString(marketEvaluation.getPolicyAttributeScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("5.3政策属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        policyAttributeTitle.setSpacingBefore(10);
        policyAttributeTitle.setSpacingAfter(10);
        document.add(policyAttributeTitle);
        addSubSubItem(document, "5.3.1 国家基本药物", marketEvaluation.getNationalEssentialDrugsRequirement(), marketEvaluation.getNationalEssentialDrugsScore());
        addSubSubItem(document, "5.3.2 国家医保药品", marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), marketEvaluation.getNationalMedicalInsuranceDrugsScore());
        addSubSubItem(document, "5.3.3 集中带量采购药品或国家谈判品种（协议期内）", marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), marketEvaluation.getCentralizedVolumePurchasingDrugsScore());

        document.close();
    }


    public void generateLianhuaQingwenReports(HttpServletResponse response, String ids) throws IOException, DocumentException {
        log.info("*******************下载id：{}*****************", ids);
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=药品遴选分析报告.doc");
        ServletOutputStream outputStream = response.getOutputStream();
        // 创建一个文档（默认大小A4，边距36, 36, 36, 36）
        Document document = new Document();
        // 设置文档大小
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        // 创建writer，通过writer将文档写入磁盘
        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        // 打开文档，只有打开后才能往里面加东西
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

        String[] split = ids.split(",");
        int xx = 0;
        for (String id : split) {
            JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "tr_info_score_v2");
            TrInheritanceEvaluationDto inheritanceEvaluation;
            TrClinicalEvaluationDto clinicalEvaluation;
            TrSafetyEvaluationDto safetyEvaluation;
            TrTechnologyEvaluationDto technologyEvaluation;
            TrMarketEvaluationDto marketEvaluation;
            TrInfoDto trInfoDto = JSONObject.parseObject(jsonObjects.toJSONString(), TrInfoDto.class);
            inheritanceEvaluation = trInfoDto.getTrInheritanceEvaluationDto();
            clinicalEvaluation = trInfoDto.getTrClinicalEvaluationDto();
            safetyEvaluation = trInfoDto.getTrSafetyEvaluationDto();
            technologyEvaluation = trInfoDto.getTrTechnologyEvaluationDto();
            marketEvaluation = trInfoDto.getTrMarketEvaluationDto();
            String drugInfo = trInfoDto.getTitle();

            document.setHeader(header);

            Paragraph paragraphTitle = createDataWordV1(jsonObjects.getString("simpleTitle"));
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
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
            String formattedDate = sdf.format(calendar.getTime());

            Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
            headWord2.setAlignment(Element.ALIGN_CENTER);
            headWord2.setSpacingBefore(9);
            headWord2.setSpacingAfter(8);
            document.add(headWord2);

            Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
            headWord3.setSpacingBefore(9);
            document.add(headWord3);

            // 新开一页
            document.newPage();

            // 摘要
            // 摘要
            Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            document.add(abstractTitle);
            Paragraph abstractContent = new Paragraph("目的 根据《河北省公立医疗机构中成药遴选评价表》对" + drugInfo + "进行临床综合评价。方法 该中成药遴选量表通过对传承评价（22分）、临床评价（25分）、安全评价（20分）、技术评价（14分）及市场评价（19分）5个方面内容，对药品进行临床综合评价归纳总结。结果 根据《河北省公立医疗机构中成药遴选评价表》：" + drugInfo + "最终得分为" + doubleToString(trInfoDto.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(abstractContent);

            // 评价目的
            Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
            // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(purposeTitle);
            Paragraph purposeContent = new Paragraph("本研究通过传承评价、临床评价、安全评价、技术评价以及市场评价5个评价维度，进行量化打分，以期对进出医疗机构的中成药进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(purposeContent);

            // 评价药品
            Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(drugTitle);
            Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
            document.add(drugContent);

            // 评价过程
            Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(processTitle);
            Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《河北省公立医疗机构中成药遴选评价表》进行量化打分，其评估维度包括传承评价、临床评价、安全评价、技术评价以及市场评价。总分加和为100分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(processContent);

            // 评价结果
            Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
            document.add(resultTitle);
            Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + doubleToString(trInfoDto.getTotalScore()) + "分，其中传承评价最终得分" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分，临床评价最终得分" + doubleToString(clinicalEvaluation.getTotalScore()) + "分，安全评价最终得分" + doubleToString(safetyEvaluation.getTotalScore()) + "分，技术评价最终得分" + doubleToString(technologyEvaluation.getTotalScore()) + "分，市场评价最终得分" + doubleToString(marketEvaluation.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
            document.add(totalScoreParagraph);

            // 药学特性
            Paragraph pharmaceuticalTitle = new Paragraph("1、传承评价（共22分，得分：" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            pharmaceuticalTitle.setSpacingBefore(10);
            pharmaceuticalTitle.setSpacingAfter(10);
            document.add(pharmaceuticalTitle);
            addSubItem(document, "1.1 组方来源", inheritanceEvaluation.getRecipeSourceContent(), inheritanceEvaluation.getRecipeSourceScore());
            addSubItemTitle(document, "1.2 理论支撑", inheritanceEvaluation.getTheorySupportScore());
            addSubItem(document, "1.2.1 中医药理论指导", inheritanceEvaluation.getTheoryGuidanceContent(), inheritanceEvaluation.getTheoryGuidanceScore());
            addSubItem(document, "1.2.2 君臣佐使配伍", inheritanceEvaluation.getTheoryCombinationContent(), inheritanceEvaluation.getTheoryCombinationScore());
            addSubItem(document, "1.2.3 君臣药的药性、归经与治疗目标是否相符", inheritanceEvaluation.getTheoryPathogenesisContent(), inheritanceEvaluation.getTheoryPathogenesisScore());
            addSubItem(document, "1.2.4 君臣药的炮制品选择与治疗目标是否相符", inheritanceEvaluation.getTheoryPotContent(), inheritanceEvaluation.getTheoryPotScore());


            addSubItemTitle(document, "1.3 病证结合", inheritanceEvaluation.getDiseaseCombinationScore());
            addSubItem(document, "1.3.1 疾病、证候、症状描述", inheritanceEvaluation.getDiseaseCombinationContent1(), inheritanceEvaluation.getDiseaseCombinationScore1());
            addSubItem(document, "1.3.2 疾病使用西医术语描述", inheritanceEvaluation.getDiseaseCombinationContent2(), inheritanceEvaluation.getDiseaseCombinationScore2());

            // 临床评价
            Paragraph clinicalTitle = new Paragraph("2、临床评价（共25分，得分：" + doubleToString(clinicalEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            clinicalTitle.setSpacingBefore(10);
            clinicalTitle.setSpacingAfter(10);
            document.add(clinicalTitle);
            addSubItem(document, "2.1 临床定位", clinicalEvaluation.getClinicalPositioningContent(), clinicalEvaluation.getClinicalPositioningScore());
            addSubItem(document, "2.2 临床研究", clinicalEvaluation.getClinicalResearchContent(), clinicalEvaluation.getClinicalResearchScore());
            addSubItem(document, "2.3 证据推荐", getEvidenceRecommendationContent(clinicalEvaluation), clinicalEvaluation.getEvidenceRecommendationScore());
            addSubItem(document, "2.4 临床需求", clinicalEvaluation.getClinicalDemandOption(), clinicalEvaluation.getClinicalDemandScore());

            // 安全评价
            Paragraph safetyTitle = new Paragraph("3、安全评价（共20分，得分：" + doubleToString(safetyEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
            safetyTitle.setSpacingBefore(10);
            safetyTitle.setSpacingAfter(10);
            document.add(safetyTitle);
            // 安全信息评价
            Paragraph safetyInfoTitle = createHeadWord(12, "3.1 安全信息评价（" + doubleToString(safetyEvaluation.getSafetyInfoScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.1安全信息评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            safetyInfoTitle.setSpacingBefore(10);
            safetyInfoTitle.setSpacingAfter(10);
            document.add(safetyInfoTitle);
            addSubSubItem(document, "3.1.1 不良反应、禁忌等描述", safetyEvaluation.getAdverseReactionContent(), safetyEvaluation.getAdverseReactionScore());
            addSubSubItem(document, "3.1.2 说明书中警示语或注意事项", safetyEvaluation.getWarningNoteContent(), safetyEvaluation.getWarningNoteScore());
            addSubSubItem(document, "3.1.3 辅料", String.valueOf(safetyEvaluation.getExcipient()), safetyEvaluation.getExcipientScore());
            addSubSubItem(document, "3.1.4 安全性再评价", safetyEvaluation.getSafetyReevaluationContent(), safetyEvaluation.getSafetyReevaluationScore());
            // 人群限制
            Paragraph populationRestrictionTitle = createHeadWord(12, "3.2 人群限制（" + doubleToString(safetyEvaluation.getCrowdRestrictionScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.2人群限制（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            populationRestrictionTitle.setSpacingBefore(10);
            populationRestrictionTitle.setSpacingAfter(10);
            document.add(populationRestrictionTitle);
            addSubSubItem(document, "3.2.1 儿童用药", safetyEvaluation.getPediatricDrugUseContent(), safetyEvaluation.getPediatricDrugUseScore());
            addSubSubItem(document, "3.2.2 妊娠期妇女用药", safetyEvaluation.getPregnancyDrugUseContent(), safetyEvaluation.getPregnancyDrugUseScore());
            addSubSubItem(document, "3.2.3 哺乳期妇女用药", safetyEvaluation.getLactationDrugUseContent(), safetyEvaluation.getLactationDrugUseScore());
            addSubSubItem(document, "3.2.4 肝功能异常者用药", safetyEvaluation.getLiverDysfunctionDrugUseContent(), safetyEvaluation.getLiverDysfunctionDrugUseScore());
            addSubSubItem(document, "3.2.5 肾功能异常者用药", safetyEvaluation.getKidneyDysfunctionDrugUseContent(), safetyEvaluation.getKidneyDysfunctionDrugUseScore());
            addSubSubItem(document, "3.2.6 运动员用药", safetyEvaluation.getAthleteDrugUseContent(), safetyEvaluation.getAthleteDrugUseScore());
            // 不良反应分级
            addSubItem(document, "3.3 不良反应分级", safetyEvaluation.getAdverseReactionStratificationContent(), safetyEvaluation.getAdverseReactionStratificationScore());

            // 技术评价
            Paragraph technologyTitle = createHeadWord(14, "4、技术评价（共14分，得分：" + doubleToString(technologyEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT); // new Paragraph("4、技术评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            technologyTitle.setSpacingBefore(10);
            technologyTitle.setSpacingAfter(10);
            document.add(technologyTitle);
            // 适宜性
            Paragraph suitabilityTitle = createHeadWord(12, "4.1 适宜性（" + doubleToString(technologyEvaluation.getSuitabilityScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("4.1适宜性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            suitabilityTitle.setSpacingBefore(10);
            suitabilityTitle.setSpacingAfter(10);
            document.add(suitabilityTitle);
            addSubSubItem(document, "4.1.1 给药频次", technologyEvaluation.getAdministrationFrequencyContent(), technologyEvaluation.getAdministrationFrequencyScore());
            addSubSubItem(document, "4.1.2 包装规格", technologyEvaluation.getPackagingSpecificationOption(), technologyEvaluation.getPackagingSpecificationScore());
            addSubSubItem(document, "4.1.3 采用大包装", technologyEvaluation.getLargePackageAdoptionOption(), technologyEvaluation.getLargePackageAdoptionScore());
            addSubSubItem(document, "4.1.4 单次用量", technologyEvaluation.getSingleDoseOption(), technologyEvaluation.getSingleDoseScore());
            addSubSubItem(document, "4.1.5 疗程", technologyEvaluation.getCourseOfTreatmentContent(), technologyEvaluation.getCourseOfTreatmentScore());
            addSubSubItem(document, "4.1.6 贮藏", technologyEvaluation.getStorageContent(), technologyEvaluation.getStorageScore());
            addSubSubItem(document, "4.1.7 有效期", String.valueOf(technologyEvaluation.getValidityPeriodContent()), technologyEvaluation.getValidityPeriodScore());
            addSubItem(document, "4.2 国家中药保护品种", String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), technologyEvaluation.getNationalTraditionalChineseMedicineProtectionScore());
            // 附加属性
            Paragraph additionalAttributesTitle = createHeadWord(12, "4.3 附加属性（" + doubleToString(technologyEvaluation.getAdditionalZodiacScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("4.3附加属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            additionalAttributesTitle.setSpacingBefore(10);
            additionalAttributesTitle.setSpacingAfter(10);
            document.add(additionalAttributesTitle);
            addSubSubItem(document, "4.3.1 中国药典", String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), technologyEvaluation.getChinesePharmacopoeiaScore());
            addSubSubItem(document, "4.3.2 专利", technologyEvaluation.getPatentNumber(), technologyEvaluation.getPatentScore());
            addSubSubItem(document, "4.3.3 独家品种", technologyEvaluation.getExclusiveVarietyInfo(), technologyEvaluation.getExclusiveVarietyScore());

            // 市场评价
            Paragraph marketTitle = createHeadWord(14, "5、市场评价（共19分，得分：" + doubleToString(marketEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT);// new Paragraph("5、市场评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
            marketTitle.setSpacingBefore(10);
            marketTitle.setSpacingAfter(10);
            document.add(marketTitle);
            addSubItem(document, "5.1 市场独特性", marketEvaluation.getMarketUniquenessOption(), marketEvaluation.getMarketUniquenessScore());
            // 单独加一横
            if (StringUtils.isNotEmpty(marketEvaluation.getMarketUniquenessContent())) {
                Paragraph marketUniquenessInfo = createDataWord("原因：" + marketEvaluation.getMarketUniquenessContent());
                document.add(marketUniquenessInfo);
            }
            addSubItemTitle(document, "5.2 经济性", marketEvaluation.getEconomicScore());
            addSubItem(document, "5.2.1 日均治疗费用", marketEvaluation.getDailyTreatmentCostOption(), marketEvaluation.getDailyTreatmentCostScore());
            addSubItem(document, "5.2.2 经济学优势", getEvidenceRecommendationContentByJson(jsonObjects.getJSONObject("trMarketEvaluationDto").getJSONArray("economicAdvantageOption")), marketEvaluation.getEconomicAdvantageScore());

            // 政策属性
            Paragraph policyAttributeTitle = createHeadWord(12, "5.3 政策属性（" + doubleToString(marketEvaluation.getPolicyAttributeScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("5.3政策属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
            policyAttributeTitle.setSpacingBefore(10);
            policyAttributeTitle.setSpacingAfter(10);
            document.add(policyAttributeTitle);
            addSubSubItem(document, "5.3.1 国家基本药物", marketEvaluation.getNationalEssentialDrugsRequirement(), marketEvaluation.getNationalEssentialDrugsScore());
            addSubSubItem(document, "5.3.2 国家医保药品", marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), marketEvaluation.getNationalMedicalInsuranceDrugsScore());
            addSubSubItem(document, "5.3.3 集中带量采购药品或国家谈判品种（协议期内）", marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), marketEvaluation.getCentralizedVolumePurchasingDrugsScore());
            addSubItemTitle(document, "5.4 生产企业状况", marketEvaluation.getProductionEnterpriseStatusScore());
            addSubItem(document, "5.4.1 生产企业", marketEvaluation.getProductionEnterpriseContent(), marketEvaluation.getProductionEnterpriseScore());
            addSubItem(document, "5.4.2 独立的GAP种植基地或全流程质量可追溯体系", marketEvaluation.getOwnPlantingBaseOption(), marketEvaluation.getOwnPlantingBaseScore());

        }

        document.close();
    }


    //--------------------------------word样式设置----------------------------------------

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
        return paragraph;
    }

    /**
     * 内容样式
     */
    public Paragraph createDataWord(String title) throws IOException, DocumentException {
        if (StringUtils.isEmpty(title)) {
            title = "暂无";
        }
        title = title.replaceAll("\\n$", "");
        Font font = createFontWord(12, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(5);
        paragraph.setSpacingAfter(5);
        return paragraph;
    }


    public Paragraph createDataWordV1(String title) throws IOException, DocumentException {
        if (StringUtils.isEmpty(title)) {
            title = "暂无";
        }
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

    // 假设已经获取到对应的实体类实例数据


    private String json = "{\n" +
            "    \"trTechnologyEvaluationDto\": {\n" +
            "        \"additionalZodiacScore\": 3,\n" +
            "        \"administrationFrequencyContent\": \"一次 4 粒，一日 3 次\",\n" +
            "        \"nationalTraditionalChineseMedicineProtectionContent\": \"该产品为国家保护品种\",\n" +
            "        \"patentScore\": 0,\n" +
            "        \"exclusiveVarietyScore\": 1,\n" +
            "        \"exclusiveVarietyInfo\": \"该药品是独家品种\",\n" +
            "        \"singleDoseOption\": \"临床常用单次用量与药品规格适配(两者比值为1)\",\n" +
            "        \"nationalTraditionalChineseMedicineProtectionScore\": 2,\n" +
            "        \"singleDoseScore\": 1,\n" +
            "        \"productionEnterpriseStatusContent\": \"根据提供的信息，药品连花清瘟胶囊的生产企业为石家庄以岭药业股份有限公司。根据相关资料：- 该公司在工信部医药工业百强榜中排名（设为□3），- 该公司在中国中药企业TOP100排行榜中排名（设为□2），- 根据调查，该公司拥有独立的GAP种植基地或建立全流程质量可追溯体系（设为加分项+1）。因此，给出的打分为：- 工信部医药工业百强榜：3分- 中国中药企业TOP100排行榜：2分- 拥有GAP种植基地：1分最终计算得分为3 + 2 + 1 = 6，但符合加分项，综合可得最后评分为1。\",\n" +
            "        \"storageScore\": 1,\n" +
            "        \"chinesePharmacopoeiaContent\": \"本品已收录在《中国药典》中。\",\n" +
            "        \"largePackageAdoptionScore\": 1,\n" +
            "        \"patentNumber\": \"无相关专利。\",\n" +
            "        \"validityPeriodContent\": \"30 个月\\n\",\n" +
            "        \"totalScore\": 10,\n" +
            "        \"validityPeriodScore\": 1,\n" +
            "        \"administrationFrequencyScore\": 1,\n" +
            "        \"largePackageAdoptionOption\": \"最小包装使用人次数高于对照药\",\n" +
            "        \"courseOfTreatmentContent\": \"暂无疗程内容\",\n" +
            "        \"chinesePharmacopoeiaScore\": 1,\n" +
            "        \"productionEnterpriseStatusScore\": 1,\n" +
            "        \"courseOfTreatmentScore\": 0,\n" +
            "        \"packagingSpecificationScore\": 1,\n" +
            "        \"packagingSpecificationOption\": \"包装规格与临床常用日剂量适配(两者比值为整数)\",\n" +
            "        \"suitabilityScore\": 4,\n" +
            "        \"storageContent\": \"密封，置阴凉处（不超过 20 ℃ ）。\\n\"\n" +
            "    },\n" +
            "    \"trInheritanceEvaluationDto\": {\n" +
            "        \"theorySupportScore\": 4,\n" +
            "        \"diseaseCombinationContent\": \"该药品的功能主治描述了用于治疗流行性感冒的症状和证候，如发热、恶寒、肌肉酸痛等，整体上符合其功效。然而，并没有采用西医术语详细阐述疾病。此外，描述虽然包含了一些相关症状，但是对于表现为流行性感冒的具体疾病，未明确划分，所以只能评分为3分。\",\n" +
            "        \"theorySupportContent\": \"该药品为上市药品该药品不遵循中医药的君臣佐使配伍原则，属于提取物或饮片\\n连花清瘟胶囊中的君臣药主要是连翘与金银花，君药连翘具有清热解毒、抗病毒的作用，臣药金银花也是清热解毒、消肿止痛的中药，这些药物的药性与归经均具有清热解毒的特性，能够针对流感、病毒性上呼吸道感染等目标疾病。由于其药物特性与治疗目标均吻合，因此可以给出最高分1分。\\n连花清瘟胶囊中的君臣药主要是连翘与金银花，这两味药物通常在中药配伍中被认为是具有清热解毒、抗病毒的功效，符合该药物的治疗目标，即用于清热解毒、治疗流感和上呼吸道感染等。同时，它们的炮制与加工过程也有助于保留其药效。因此，从药物选择与治疗目标的符合程度来看，这一部分可以得到满分（1分）。\",\n" +
            "        \"totalScore\": 14,\n" +
            "        \"recipeSourceScore\": 7,\n" +
            "        \"diseaseCombinationScore\": 3,\n" +
            "        \"recipeSourceContent\": \"连花清瘟胶囊是通过现代科研和临床实践，结合了古代经典名方的一些成分，但它并非完全源于古代经典名方。该药物是在对疫情特征的理解基础上进行的创新性研制，因此可以被归类为研制方。具体原因如下：1. 构成成分：虽然部分成分可以追溯至古代中医药文献（如《伤寒论》等），但连花清瘟的组方是经过现代药理研究和临床试验优化的。2. 使用背景：连花清瘟胶囊在新冠疫情等现代疾病背景下被研发，其疗效和用途是基于现代医学的需求和验证，而古代经典名方则主要是为了应对当时常见的疾病。3. 创新性：在药物的配方和使用方法上，连花清瘟胶囊相比于传统古方有较大的创新，添加了新颖的成分和制剂形态，体现了现代医学发的方向。因此，根据评分标准，连花清瘟胶囊可以评分为7分，归类为研制方。\"\n" +
            "    },\n" +
            "    \"trSafetyEvaluationDto\": {\n" +
            "        \"kidneyDysfunctionDrugUseScore\": 0,\n" +
            "        \"excipient\": \"连翘、金银花、炙麻黄、炒苦杏仁、石膏、板蓝根、绵马贯众、鱼腥草、广藿香、大黄、红景天、薄荷脑、甘草。辅料为玉米淀粉。\\n\",\n" +
            "        \"pediatricDrugUseScore\": 0,\n" +
            "        \"athleteDrugUseScore\": 0,\n" +
            "        \"athleteDrugUseContent\": \"运动员慎用。\",\n" +
            "        \"pregnancyDrugUseContent\": \"6. 儿童、孕妇、哺乳期妇女、年老体弱及脾虚便溏者应在医师指导下服用。\",\n" +
            "        \"lactationDrugUseScore\": 0.5,\n" +
            "        \"kidneyDysfunctionDrugUseContent\": \"4. 高血压、心脏病患者慎用。有肝病、糖尿病、肾病等慢性病严重者应在医师指导下服用。\",\n" +
            "        \"pregnancyDrugUseScore\": 0.5,\n" +
            "        \"liverDysfunctionDrugUseContent\": \"1. 注意事项中提到：有肝病、糖尿病、肾病等慢性病严重者应在医师指导下服用。2. 可以判断肝功能异常者需谨慎使用，但并未说明可以使用，所以对肝功能异常者的相关内容禁用得分为0分。\",\n" +
            "        \"safetyReevaluationContent\": \"《连花清瘟胶囊治疗流行性感冒疗效和安全性的系统评价》\\n《连花清瘟胶囊治疗流行性感冒的有效性及安全性的系统评价》\\n《连花清瘟胶囊治疗病毒性感冒的有效性和安全性的系统评价》\\n《连花清瘟胶囊治疗病毒性感冒的有效性和安全性的系统分析》\\n《连花清瘟胶囊对比奥司他韦治疗流行性感冒疗效和安全性的Meta分析》\\n《连花清瘟制剂对COVID-19疗效的Meta分析》\\n《连花清瘟治疗流行性感冒临床疗效的Meta分析》\\n《连花清瘟颗粒辅助治疗小儿肺炎支原体肺炎有效性Meta分析》\\n《连花清瘟辅助治疗成人肺炎有效性和安全性的Meta分析与系统综述》\\n《连花清瘟联合西医治疗新型冠状病毒肺炎临床疗效的Meta分析》\\n\",\n" +
            "        \"warningNoteContent\": \"1. 忌烟、酒及辛辣、生冷、油腻食物。\\n2. 不宜在服药期间同时服用滋补性中药。\\n3. 风寒感冒者不适用。\\n4. 高血压、心脏病患者慎用。有肝病、糖尿病、肾病等慢性病严重者应在医师指导下服用。\\n5. 儿童、孕妇、哺乳期妇女、年老体弱及脾虚便溏者应在医师指导下服用。\\n6. 发热体温超过 38.5 ℃ 的患者，应去医院就诊。\\n7. 严格按用法用量服用，本品不宜长期服用。\\n8. 服药 3 天症状无缓解，应去医院就诊。\\n9. 对本品过敏者禁用，过敏体质者慎用。\\n10. 本品性状发生改变时禁止使用。\\n11. 儿童必须在成人监护下使用。\\n12. 请将本品放在儿童不能接触的地方。\\n13. 如正在使用其他药品，使用本品前请咨询医师或药师。\\n14. 运动员慎用。\\n15. 打开防潮袋后，请注意防潮。\\n\",\n" +
            "        \"warningNoteScore\": 0,\n" +
            "        \"adverseReactionStratificationContent\": \"在药品说明书中提到的不良反应包括恶心、呕吐、腹痛、腹泻、腹胀等，一般情况下这些反应可能需要调整给药方案以预防症状加重，因此需要改变给药方案。\",\n" +
            "        \"pediatricDrugUseContent\": \"1. 儿童、孕妇、哺乳期妇女、年老体弱及脾虚便溏者应在医师指导下服用。2. 儿童必须在成人监护下使用。3. 请将本品放在儿童不能接触的地方。\",\n" +
            "        \"excipientScore\": 2,\n" +
            "        \"totalScore\": 11,\n" +
            "        \"lactationDrugUseContent\": \"注意事项中提到哺乳期妇女应在医师指导下服用，因此应为慎用。\",\n" +
            "        \"adverseReactionStratificationScore\": 3,\n" +
            "        \"safetyReevaluationScore\": 3,\n" +
            "        \"adverseReactionContent\": \"上市后监测数据显示本品可见以下胃肠道不良反应如恶心、呕吐、腹痛、腹泻、腹胀、反胃，以及皮疹、瘙痒、口干、头晕等。\\n\",\n" +
            "        \"safetyInfoScore\": 7,\n" +
            "        \"crowdRestrictionScore\": 1,\n" +
            "        \"adverseReactionScore\": 2,\n" +
            "        \"liverDysfunctionDrugUseScore\": 0\n" +
            "    },\n" +
            "    \"totalScore\": 712,\n" +
            "    \"trMarketEvaluationDto\": {\n" +
            "        \"nationalMedicalInsuranceDrugsPaymentRequirement\": \"该药品属于医保甲类，无支付限制\",\n" +
            "        \"marketUniquenessOption\": \"具有不可替代的唯一性或填补市场空白\",\n" +
            "        \"economicOption\": \"日均治疗费用较同类中成药价格较低，且具有明显的药物经济学优势\",\n" +
            "        \"totalScore\": 14,\n" +
            "        \"nationalEssentialDrugsScore\": 3,\n" +
            "        \"marketUniquenessScore\": 3,\n" +
            "        \"centralizedVolumePurchasingDrugsSource\": \"不属于国家/联盟集中采购药品。\",\n" +
            "        \"policyAttributeScore\": 0,\n" +
            "        \"nationalMedicalInsuranceDrugsScore\": 3,\n" +
            "        \"economicScore\": 5,\n" +
            "        \"nationalEssentialDrugsRequirement\": \"该药品被《国家基本药物目录》收载\",\n" +
            "        \"centralizedVolumePurchasingDrugsScore\": 0\n" +
            "    },\n" +
            "    \"trClinicalEvaluationDto\": {\n" +
            "        \"clinicalResearchContent\": \"《连花清瘟胶囊治疗呼吸系统感染的循证评价》\\n《连花清瘟胶囊及其基础研究和临床应用Meta分析》\\n《连花清瘟胶囊/颗粒不良反应的系统评价与Meta分析》\\n《连花清瘟胶囊治疗流行性感冒疗效和安全性的系统评价》\\n《连花清瘟胶囊治疗流行性感冒的有效性及安全性的系统评价》\\n《连花清瘟胶囊治疗病毒性感冒的有效性和安全性的系统评价》\\n《连花清瘟胶囊治疗病毒性感冒的有效性和安全性的系统分析》\\n《连花清瘟胶囊辅助治疗社区获得性肺炎效果及安全性的Meta分析》\\n《连花清瘟胶囊对比奥司他韦治疗流行性感冒疗效和安全性的Meta分析》\\n《连花清瘟制剂对COVID-19疗效的Meta分析》\\n\",\n" +
            "        \"clinicalResearchScore\": 5,\n" +
            "        \"evidenceItems\": [\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎早期中成药干预的药学共识（北京）\",\n" +
            "                \"content\": \"早期干预中成药分为A类和B类，A类以宣肺清热为主适用于发热风寒患者，B类以清热解毒为主适用于发热咽干咽痛患者。新冠肺炎治疗中成药包括多款药品，具备不同功效，如清热解毒、利咽、退热、通便利尿等。药品组成多样，包括藿香止气胶囊、连花清瘟胶囊、金花清感颗粒等，适用于不同情况的患者。中成药使用需遵循说明书用法用量，可在安全性评估后适当增加服药频次。各地可参照共识方案根据个体情况进行辨证论治，早期干预药品涵盖各类可能的外感类型，宜足量用药，并不应超过说明书最大量的150%。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎诊疗方案（试行第九版）\",\n" +
            "                \"content\": \"乏力伴胃肠不适推荐中成药：藿香正气胶囊（丸、水、口服液)\\n\\t乏力伴发热推荐中成药：金花清感颗粒、连花清瘟胶囊（颗粒）、疏风解毒胶囊（颗粒）\\n\\t适用范围：结合多地医生临床观察，适用于轻型、普通型、重型患者，在危重型患者救治中可结合患者实际情况合理使用\\n\\t基础方剂：麻黄9g、炙甘草6g、杏仁9g、生石膏15~30g（先煎）...\\n\\t清肺排毒颗粒服法：开水冲服，一次2袋，一日2次。疗程 3～6天\\n\\t寒湿疫方亦适用于普通型患者\\n\\t古质暗红，古体胖，苔黄腻或黄燥，脉滑数或弦滑\\n\\t基础方剂：麻黄6g、炒苦杏仁15g、生石膏30g、薏苡仁30g、麸炒苍术10g、广藿香15g、青蒿12g、虎杖 20g、马鞭草30g、芦根30g、子15g、化橘红15g、甘草10g\\n\\t推荐中成药：宣肺败毒颗粒服法：开水冲服，一次1袋，每日2次。疗程7～14天，或遵医瞩\\n\\t恶寒，发热，肌肉酸痛，流涕，干咳，咽痛，咽痒，口干、咽干，便秘，舌淡、少津，苔薄白或干，脉浮紧\\n\\t基础方剂：麻黄 6g、杏仁 10g、柴胡12g、沙参15g、麦冬15g、玄参15g、白芷10g、羌活 15g、升麻8g、桑叶15g、黄芩10g、桑白皮15g\\n\\t推荐中成药：金花清感颗粒、连花清瘟胶囊(颗粒)金花清感颗粒服法：开水冲服，一次1～2袋，一日3次\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"中成药治疗小儿急性上呼吸道感染临床应用指南（2020年）\",\n" +
            "                \"content\": \"使用条件：3~5岁，1次1粒，6~10岁，1次2粒，>11岁，1次4粒，1天3次（基于专家经验的专家共识）。对于服药困难患儿，可去掉胶囊，将药粉溶于水冲服。安全性：上述推荐意见的安全性证据尚不充分，临床医生在使用时需注意观察患者实际用药安全性。证据描述：1项研究53报道了连花清瘟胶囊治疗3天对流感患儿（120例）发热、头痛、咽痛、肌肉痛的影响。对照奥司他韦颗粒。Meta分析结果显示，总有效率不劣于奥司他韦颗粒RR=1．07，95%C/[0．98，1．28），P=0．15]；退热时间短于奥司他韦颗粒MD=-0．60，95%CI(-0．78，-0．42)，P<0．0001l。解释说明：时疫外感为小儿感冒常见证型，连花清瘟胶囊虽证据质量不到B级，但临床应用广泛，疗效确切，且用药急需，专家共识推荐高达86%，但考虑该药为成人药品，故在此给予弱推荐。3．11临床问题11小儿上感伴发热、惊厥或有疱疹性咽峡炎3．11．1推荐意见11推荐镇静止惊基础上联合使用儿童回春颗粒治疗3~7天，可减少高热惊蕨发作（2D）；联合应用利巴韦林7天，可缩短疱疹性咽峡炎患儿发热时间、疱疹消失时间及流涎时间（2D）使用条件：用法用量：1岁以内，1次1．259；1~2岁，1次2．59；3~4岁，1次39；5~7岁，1次59；1天2次~3次。安全性：纳入的2项报道不良反应情况，报道儿童回春颗粒未见不良反应。证据描述：2项研究54．55报道了儿童回春颗粒治疗3~7大对小儿上感患者（360例）控制惊蕨发作显效率、发热及咽部疱疹的影响。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新冠肺炎诊疗方案治疗药物信息汇编（第一版）\",\n" +
            "                \"content\": \"本品为祛湿剂，主要用于治疗寒湿或暑湿感冒。藿香正气水含乙醇，不宜驾车和操作机器，不得与特定药物联合使用以免出现不良反应。金花清感颗粒、连花清瘟胶囊、疏风解毒胶囊、防风通圣丸等药物均具有清热解毒功效。同时提醒不宜同时服用滋补性中成药，含麻黄，运动员、高血压、心脏病患者慎用。临床症状包括发热、咳嗽、腹胀便秘等，推荐中成药喜炎平注射剂、而必净注射剂。使用中成药注射剂需严格按照给药途径、功能主治、用法用量及疗程等原则，避免混合配伍、过量使用。特殊人群和初次使用中成药注射剂的患者需慎重使用，加强监测和用药监护。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"中成药防治新型冠状病毒肺炎专家共识\",\n" +
            "                \"content\": \"湿邪郁肺证：\\n\\t- 低热或不发热，乏力，周身酸痛，咳嗽，咯痰，胸闷憋气\\n\\t- 纳呆，恶心，呕吐，大便黏滞不爽\\n\\t- 可见舌质淡胖有齿痕或舌质淡红，舌苔白腻或白厚腐腻，脉濡或滑\\n湿热蕴肺证：\\n\\t- 低热或不发热，微恶寒，乏力，头身困重，肌肉酸痛\\n\\t- 十咳痰少，咽痛，口十不欲多饮，或伴有胸闷脘痞，汗出不畅\\n\\t- 或见呕恶纳呆，便唐或大便黏滞不爽\\n热毒袭肺证：\\n\\t- 发热，恶寒，咽干痛，干咳少痰，头痛、口干渴，乏力\\n\\t- 舌红，舌苔薄黄，脉浮数\\n中成药治疗推荐:\\n- 连花清瘟胶囊（颗粒）\\n- 金花清感颗粒\\n- 柴石退热颗粒\\n- 藿香正气口服液\\n- 抗病毒颗粒（口服液）\\n- 清肺消炎丸\\n- 金花清感颗粒\\n- 克感利咽口服液\\n- 荆防颗粒\\n- 九味羌活颗粒（丸）\\n中医学对COVID-19的认识:\\n- COVID-19具有强烈传染性和致病性\\n- 根据病因发病特点，病理性质为“湿、热、毒、虚、瘀”\\n- COVID-19诊断标准及临床分型可参照国家卫健委和国家中医药管理局印发的指导方案\\n- 轻型患者病势轻浅而止气未虚，中药治疗以透解为主\\n- 一般治疗包括卧床休息，充分热量摄入，保持水、电解质和酸碱平衡\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"山东省新型冠状病毒肺炎诊疗专家共识\",\n" +
            "                \"content\": \"本病属于中医疫病范畴，病因为感受疫戾之气，由时疫湿邪所致。寒湿疫邪多从口鼻而入，郁闭肺气；继则郁而化热，湿热交结，疫毒闭肺；甚则热入营血，乃致内闭外脱；病久耗气伤阴，出现肺脾气虚之证。根据目前掌握的资料，中医药可改善症状、缩短病程，避免由普通型向重型转化的风险。中西医联合救治还可降低重型和危重型患者病死率。推荐中医药尽早、全程参与。临床表现乏力伴胃肠不适者，推荐采用藿香正气胶囊（丸、水、口服液)；临床表现乏力伴发热者，推荐采用连花清瘟胶囊（颗粒）、疏风解毒胶囊（颗粒）、复方银花解毒颗粒等。（1)清肺排毒汤：适用于轻型、普通型、重型患者，在危重型患者救治中可结合患者实际情况合理使用。基础方剂：麻黄9g、炙甘草6g香仁9g、生石膏15～30g（先煎）、桂枝9g、泽泻9g猪苓9g白术9g茯苓15g、柴胡16g、黄苓6g姜半夏9g生姜9g紫苑9g、冬花9g射十9g细辛6g山药12g、积实6g陈皮6g藿香9g。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"人感染H7N9禽流感诊疗方案（2017年第1版）\",\n" +
            "                \"content\": \"③扎那米韦（Zanamivir）：适用于7岁以上人群。每日2次，间隔12小时；每次10mg（分两次吸入）。不建议用于重症或有并发症的患者。（2）离子通道M2阻滞剂：目前监测资料显示所有H7N9禽流感病毒对金刚烷胺（Amantadine）和金刚乙胺（Rimantadine）耐药，不建议使用。1．热毒犯肺，肺失宣降证（疑似病例或确诊病例病情轻者）。症状：发热，咳嗽，甚者喘促，少痰，或头痛，或肌肉关节疼痛。舌红苔薄，脉数滑。治法：清热解毒，宣肺止咳。参考处方和剂量：银翘散、白虎汤、宣白承气汤。金银花 30g、连翘15g、炒杏仁15g、生石膏30g知母10g、桑白皮15g、全瓜萎30g、青蒿15g黄芩15g、麻黄6g、生甘草6g水煎服，每日1～2剂，每4～6小时口服一次。加减：咳嗽甚者加枇杷叶、浙贝母。中成药：可选择疏风解毒胶囊、连花清瘟胶囊、金莲清热泡腾片等具有清热解毒，宣肺止咳功效的药物。中药注射液：痰热清注射液、喜炎平注射液、热毒宁注射液、血必净注射液、参麦注射液。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎中药合理使用专家共识（第一版）\",\n" +
            "                \"content\": \"有个别患者使用射干用药后出《方案》中的口服中成药共涉及6个品种。由于中成药的厂家、规格剂型较多，因此须辨证选用，谨慎与中药汤剂联用。参考药品说明书，对药品的组成、功效、主治进行整理，见表6。不同剂型的药品应用辅料不同，组成中未罗列。整理不同剂型的药品规格、用法用量以及所含的毒性成分，见表7。结合约品说明书及各类中成约的安全用药信息，见表8。临床药师在审方及临床实践过程中，重点关注的药学监护要点，以及口服中成药多用十医学观察期，患者多为轻症，在使用过程中警惕性较低，需要重点做好用药监护，提高用药安全，以免造成不良后果。（1）注意药性辨别。以上中成药可分为三类：化湿解暑剂（藿香止气胶囊/丸/水/口服液）、清热解毒剂（连花清瘟胶囊/颗粒、金花清感颗粒、统风解毒胶囊/额粒）、开玲剂（苏合香丸、安营牛黄丸）。霍香正气万剂味羊性温，适用于湿阻中焦之证，不可用于风热证；清热解毒类，味苦性寒凉，适用于风热表证，不可用于风寒证，所以一定注意区分此两类药，以免混淆。开窍剂是用于临床治疗期（确诊用干赛闭证，面安营牛黄丸性寒凉，用于热闭证，二者不可互相替代或混用。（2）避免不合理联用。清热解毒类推荐的3种中成药，主治证型基本一致，应避免叠加使用。谨慎联用相同证型的其他中成药，避免超剂量用药风险。患者服用中药汤剂期间，应避免与以上中成药同时服用。（3)注意毒性成分，避免超剂量超疗程服用，尤其是含有朱砂、雄黄的中成药，不建议用于正常人的预防用药。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒感染诊疗方案（试行第十版）\",\n" +
            "                \"content\": \"服法：\\n\\t每日1剂，水煎服。早晚各1次，餐后40分钟服用，3日一个疗程。患者不发热则生石膏用量小，发热或壮热可加大生石膏用量。\\n推荐中成药：\\n\\t清肺排毒颗粒\\n临床表现：\\n\\t发热头痛，无汗，身体酸痛，咽痒咳嗽或咽干痛，痰粘少，鼻塞浊涕。舌红，苔薄白或薄黄，脉浮数。\\n推荐处方：\\n\\t葛根15g、荆芥10g、柴胡15g、黄芩15g、薄荷10g、桂枝10g、白芍10g、金银花15g、桔梗15g、积壳10g、前胡15g、川芎10g、白芷10g、甘草10g。\\n推荐中成药：\\n\\t藿香正气胶囊（软胶囊、丸、水、口服液）、疏风解毒胶囊（颗粒)、清肺排毒颗粒、化湿败毒颗粒、宣肺败毒颗粒、散寒化湿颗粒、金花清感颗粒、连花清瘟胶囊（颗粒）等。\\n针灸治疗推荐穴位：\\n\\t内关、孔最、曲池、气海、阴陵泉、中脘。\\n麻黄6g、炒苦杏仁9g、生石膏15g（先煎）、甘草3g、广藿香10g、厚朴10g、苍术15g、草果10g、法半夏9g、茯苓15g、生大黄5g（后下）、黄芪10g、子10g、赤芍10g服法：每日1～2剂，水煎服，每次100m1～200m1，一日2～4次，口服或鼻饲。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"甲型H1N1流感诊疗方案（2010年版）\",\n" +
            "                \"content\": \"（四）中医辨证治疗。1．轻症辨证治疗方案。（1）风热犯卫主症：发病初期，发热或未发热，咽红不适，轻咳少痰，无汗。舌脉：舌质红，苔薄或薄腻，脉浮数。治法：疏风清热基本方药：银花15g连翘15g桑叶10g菊花10g桔梗10g牛蒡子15g竹叶6g芦根30g薄荷（后下)3g生甘草3g煎服法：水煎服，每剂水煎400毫升，每次口服200毫升，1日2次；必要时可日服2剂，每6小时口服1次，每次200 毫升。加减：苔厚腻加藿香10g、佩兰10g;咳嗽重加杏仁10g、炙枇杷叶10g;若呕吐可先用黄连6g，苏叶10g水煎频服。腹泻加黄连6g、木香 3g;咽痛重加锦灯笼9g。常用中成药：疏风清热类中成药如疏风解毒胶囊、银翘解毒类、桑菊感冒类、双黄连类口服制剂，藿香正气类、葛根芩连类制剂等。儿童可选儿童抗感颗粒、小儿豉翘清热颗粒、银翘解毒颗粒、小儿感冒颗粒、小儿退热颗粒。(2)热毒袭肺。主症：高热，咳嗽，痰粘咯痰不爽，口渴喜饮，咽痛，目赤。舌脉：舌质红，苔黄或腻，脉滑数。治法：清肺解毒基本方药：炙麻黄5g杏仁10g生石膏知母10g浙贝母10g桔梗10g黄芩15g柴胡15g生甘草10g煎服法：水煎服，每剂水煎400毫升，每次口服200毫升，1日2次；必要时可日服2剂，每6小时口服1次，每次200毫升。加减：便秘加生大黄（后下）6g;持续高热加青蒿15g、丹皮10g。常用中成药：清肺解毒类如连花清瘟胶囊、银黄类制剂、莲花清热类制剂等。儿童可选小儿肺热咳喘颗粒（口服液）、小儿咳喘灵颗粒（口服液）、羚羊角粉冲服。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"脓毒症急性胃肠功能障碍中西医结合临床专家共识\",\n" +
            "                \"content\": \"湿热雍滞证是脓毒症AGIⅡ级常见的中医证型，病机特点是热毒人里渐深，炼津为痰，气营皆受灼，推荐使用大承气汤等方药。对症治疗可使用促胃肠动力药和导泻药，营养补充可考虑使用微生态调节剂等。胃肠功能丧失进展至腹腔内高压时，热毒瘀滞证或腑实血瘀证是常见中医证型，病机特点是炼血成瘀，热入营血，痰、热、瘀相互搏结，推荐使用大黄牡丹汤等方药。脓毒症AGIIV级时，阳气暴脱证或肾阴耗竭证是常见中医证型，病机特点是热入血分，气随血脱，导致脏腑精气衰微，推荐分别使用相应的方药。保守治疗不能解决脓毒症AGIIV级的情况。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎临床防治方案专家共识\",\n" +
            "                \"content\": \"8．3．4肾替代治疗危重型患者出现高钾血症、严重酸中毒、肺水肿或水负荷过重、多器官功能不全时的液体管理，可选择连续性肾替代治疗（continuousrenalreplacementtherapy，CRRT）。8．4中医药治疗中医药在治疗各种疫病方面有独特的优势，疫情期间厂泛应用于轻型和普通型COVID-19患者的治疗，取得了较好的效果。中医药治疗COVID-19应遵循早期干预、辩证施治的原则，结合病情采取个体化治疗，即“辨病为主、病证结合、专病专方”。建议在中医师的指导下实施治疗。(1)轻型：治则是解表发散、扶正散邪。处方为葱豉汤合玉屏风散加减。推荐成药：乏力伴胃肠不适者，藿香正气胶囊（丸、水、口服液)；乏力伴发热者，金花清感颗粒、连花清瘟胶囊（颗粒)、疏风解毒胶囊(颗粒）。(2)普通型：寒湿疫毒袭肺证治则是散寒祛湿、解表除疫。处方为九味羌活汤、神授太乙汤加减。1)热重于湿的寒湿疫毒蕴肺证治则是辛凉宣池，化湿透邪，以升降散、栀子鼓汤加味：（2湿重于热的寒湿疫毒蕴肺证治则是利湿化浊，清热解毒，以甘露消毒丹、达原饮加减。（3)重型：①热结胸膈证治则是泻火解毒，清上泻下，方药为凉膈散。②毒抚心神证治则是清热泻毒，透热达邪，宁心安神。方药采用紫雪丹。③痰热雍肺、毒瘀互结证治则是化瘀宣泄，清肺降逆。处方为桃红麻杏石甘汤、桔梗汤加味。（4邪毒闭肺证治则是通肺泻热，清肺解毒。处方为解毒承气汤、宣白承气汤。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"肺癌患者新型冠状病毒感染防治专家共识\",\n" +
            "                \"content\": \"一项中国专家调研显示,NSCLC合并新冠病毒感染时，95．95%专家认为应停止化疗，86．91%专家认为重型/危重型新冠病毒肺炎应停止靶向治疗，95．95%专家认为应停止免疫治疗本病属于中医“疫”病范畴，病因为感受“疫戾”之气，各地可根据病情、证候及气候等情况进行辨证论治。清肺排毒汤适用于轻型、中型、重型、危重型病例，可结合患者情况规范使用。可使用的中成药包括藿香正气胶囊（软胶囊、丸、水、口服液）、疏风解毒胶囊（颗粒）、清肺排毒颗粒、化湿败毒颗粒、宣肺败毒颗粒、散寒化湿颗粒、金花清感颗粒、连花清瘟胶囊（颗粒）等。早期识别重症患者是新冠病毒救治的关键。国家卫生健康委员会发布《新型冠状病毒感染重症病例诊疗方案（试行第四版）》提出，对于未达到重症病例诊断标准，但出现新冠病毒感染导致的肺炎且有以下情况之一者，亦可按重症病例管理：年龄>65岁；未完成全程疫苗接种；合并较为严重慢性疾病（包括高血压、糖尿病、冠心病、慢性肺部疾病、恶性肿瘤，以及免疫功能低下等）64。因此，肺癌患者感染新冠病毒后应按重症病例管理，早期积极干预，监测生命体征，特别是静息和活动后的指氧饱和度等，同时对基础疾病相关指标进行监测。《新型冠状病毒感染诊疗方案（试行第十版）》指出，有以下指标变化应警惕病情恶化：低氧血症或呼吸窘迫进行性加重：组织氧合指标（如指氧饱和度、氧合指数）恶化或乳酸进行性升高；外周血淋巴细胞计数进行性降低或炎症因子如白细胞介素6、C反应蛋白、铁蛋白等进行性上升；D二聚体等凝血功能相关指标明显升高：胸部影像学显示肺部病变明显进展治疗重症病例应保证充分的能量和营养摄入，注意水、电解质平衡，维持内环境稳定。高热者可进行物理降温、应用解热药物。咳嗽咳痰严重者给予止咳祛痰药物。避免盲目或不恰当使用抗菌药物，尤其是联合使用广谱抗菌药物。有基础疾病者给予相应治疗。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"中医药治疗流感临床实践指南（2021）\",\n" +
            "                \"content\": \"6．6．1金花清感颗粒（证据级别：B；推荐强度：强推荐)主要成分：金银花、石膏、蜜麻黄、炒苦杏仁、黄芩、连翘、浙贝母、知母、牛蒡子、青蒿、薄荷、甘草。说明书适应症：疏风宣肺，清热解毒。用于单纯型流行性感冒轻症，中医辨证属风热犯肺证者，症见发热，头痛，全身酸痛，咽痛，咳嗽，恶风或恶寒，鼻塞流涕，舌质红，舌苔薄黄，脉数。用法用量：开水冲服。每次1袋，每日3次，疗程3天。6．6．2疏风解毒胶囊（证据级别：C；推荐强度：强推荐）主要成分：虎杖、连翘、板蓝根、柴胡、败酱草、马鞭草、芦根、甘草。说明书适应症：疏风清热，解毒利咽。用于急性上呼吸道感染属风热证，症见发热，恶风，咽痛，头痛，鼻塞，流浊涕，咳嗽等。用法用量：口服。每次4粒，每日3次。6．6．3连花清瘟胶囊［60-99］（证据级别：D；推荐强度：强推荐）主要成分：连翘、金银花、炙麻黄、炒苦杏仁、石膏、板蓝根、绵马贯众、鱼腥草、广藿香、大黄、红景天、薄荷脑、甘草。辅料为玉米淀粉。说明书适应症：清瘟解毒，宣肺泄热。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"四川省流行性感冒中西医结合诊疗专家共识（2023版）\",\n" +
            "                \"content\": \"基本方药：荆防败毒散（《摄生众妙方》）加减。主要组成：荆芥15g、防风15g羌活15g、柴胡10g前胡10g独活15g积壳10g川芎10g、辛夷（包煎）10g、生甘草5g。煎服法：水煎服，每剂水煎450ml，每次口服150ml，3次/日。常用中成药：解表散寒类，如荆防颗粒、散寒解热口服液、风寒感冒颗粒等。6．3．2风热袭表主症：发热或未发热，咽痛，轻咳少痰。舌脉：舌质红，苔薄黄，脉浮数。治法：辛凉解表，疏风清热。基本方药：银翘散合桑菊饮（《温病条辨》加减。主要组成：银花15g、连翘15g桑叶10g、菊花10g、桔梗10g、牛蒡子10g、竹叶10g、薄荷（后下)5g、生甘草5g。煎服法:水煎服，每剂水煎450ml，每次口服150ml,3次/日。常用中成药：疏风解表、清热解毒类，如抗病毒冲剂、金花清感颗粒、连花清瘟胶囊（颗粒）、清开灵颗粒（胶囊、软胶囊、片）、疏风解毒胶囊、银翘解毒类、桑菊感冒类等。躁，口渴。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒感染：医院药学工作指导与防控策略专家共识（第一版）\",\n" +
            "                \"content\": \"本病属于中医疫病范畴，病因是感受疫戾之气，各地可根据病情、当地气候特点以及不同体质等情况，参照下列方案进行辨证论治。临床表现之力伴管肠不证推荐中成药：霍查正气胶囊（丸、水、口服液临床表现2：乏力伴发热推荐中成药：金花清感颗粒、连花清瘟胶囊（颗粒)、疏风解毒胶囊（颗粒)防风通圣丸（颗粒）1）初期：寒湿郁肺临床表现：恶寒发热或无热，干咳，咽干，倦怠乏力胸闷，脘痞，或呕恶，便。舌质淡或淡红，苔白腻，脉濡。推荐处方：苍术15g、陈皮10g、厚朴10g、广藿香10g、草果6g、麻黄6g、羌活10g、生姜10g、槟榔10g2）中期：疫毒闭肺临床表现：身热不退或往来寒热，咳嗽痰少，或有黄痰，腹胀便秘。胸闷气促，咳嗽喘憋，动则气喘。舌质红，苔黄腻或黄燥，脉滑数。推荐处方：苦杏仁10g、生石膏30g（先煎）、瓜萎30g、生大黄6g（后下)生、炙麻黄各6g、子10g（包煎）、桃仁10g、草果6g、槟榔10g、苍术10g3）重症期：内闭外脱临床表现：呼吸困难、动辄气喘或需要辅助通气，伴神昏，烦躁，汗出肢冷，舌质紫暗，苔厚腻或燥，脉浮大无根。推荐处方：人参15g、黑顺片10g（先煎）、山茱萸15g，送服苏合香丸或安宫牛黄丸推荐中成药：血必净注射液、参附注射液、生脉注射液4）恢复期：肺脾气虚临床表现：气短、倦怠乏力、纳差呕恶、痞满，大便无力，便沥不爽，舌淡胖，苔白腻。推荐处方：法半夏9g、陈皮10g、党参15g、炙黄芪 30g、茯苓15g、藿香10g、砂仁6g（后下）为保障疫情期间药学部门感染预防与控制工作的有效实施，并提供有效药学服务保障，应在医疗机构统一领导下，成立药学工作领导小组，建立相应的应急颁案和工作流程，其内药品保障供应、药品调剂管理、临床药学服务管理、用药咨询管理、药品质量控制管理、药学教育与科研管理、疫情防控与消毒、应对全员进行2019-nCoV防控知识的培训，并依据岗位职责确定针对不同人员的培训内容，尤其是对高风险的部门（发热药房、隔离病区的药房、急诊药房）和参加高风险操作（如有与确诊或疑似患者的接触、患者标本处理可能产生的气溶胶或体液暴露的接触操作）的药学人员要重点培训。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎药物预防、诊断、治疗与出院管理循证临床实践指南（更新版）\",\n" +
            "                \"content\": \"推荐理由：在权衡利弊后，考虑到证据的质量、患者的偏好、可接受性和可行性，指南专家组对连花清瘟颗粒/胶囊联合常规疗法治疗COVD-19给出弱推荐。证据总结：一项Cochrane系统评价[1o2讨了恢复期血浆对COVID-19患者的有效性，对照组接受SOC(检索至2020年6月4日)。其中一项NRSI(21例受试者，其中6例接受了恢复期血浆)结果表明，恢复期血浆对出院时的全因病死率没有影响(RR=0．89，95%CI0．61~1．31，P=0．56)。一项RCT(103例受试者，其中能不会延长死亡时间(RCT：HR=0．74，95%CI0．30~1．82；NRSI：HR=0．46，95%CI0．22~0．96)，且不能改善第7天(RCT：RR=0．98，95%CI:0．30~3．19)、第14天(RCT：RR=1．85，95%CI0．91~3．77；NRSI:RR=1．08,95%CI0．91~1．29)和第28天(RCT：RR=1．20，95%CI0．80~1．81)的临床症状。该系统评价纳入了一项RCT、3项NRSI和10项无对照组的NRSI评估恢复期血浆的安全性，其中13项（201例受试者)报告了3级或4级不良反应，多为过敏或呼吸道反应；一项非对照的NRSI(5000例参与者)仅报告了恢复期血浆输注后4h内发生的严重不良反应。该系统评价报告了15例死亡，其中4例归类为潜在，可能或绝对与输血有关。由于研究设计、受试者类型以及其他先前或同时进行的治疗，儿乎所有纳入研究均显示出明显的偏倚风险，如纳入的RCT对参与者和研究人员未施盲，选择性报告偏倚以及数据不完整。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"北京协和医院新型冠状病毒感染基层诊疗方案建议及适宜技术（第一版[2023.1.3]）\",\n" +
            "                \"content\": \"(5）腹泻：部分患者可能出现腹泻症状，大部分为轻度分泌型腹泻。补液和维持电解质稳定是最重要的洽疗，首选经口补液，如腹泻量大，可予口服补液盐。腹泻可导致肠道菌群紊乱，可口服肠道益生菌调节肠道菌群。少数患者可出现严重腹泻，以及抗生素相关腹泻，需完善大便常规及病原学检查，如除外感染性腹泻，可适当加用蒙脱石散止泻。如伴恶心，甚至呕吐，注意饮食清淡，少量多餐，呕吐严重需及时就诊。值得注意的是新冠病毒可能通过粪口传播，因此对于腹泻的患者尤其需要注意手卫生。（1）常用的中成药包括：感冒清热颗粒、荆防颗粒、小柴胡颗粒、金花清感颗粒、连花清瘟胶囊（颗粒）、双黄连口服液、清热解毒口服液等。1可用于缓解咽痛的中成药包括：清咽滴丸等。②)可用于缓解咳嗽的中成药包括：羚羊清肺丸、复方鲜竹沥口服液、止咳橘红丸、川贝枇杷膏、养阴清肺丸、苏黄止咳胶囊等。③可用于缓解鼻塞、流涕的中成药：鼻渊通窍颗粒。④可用于缓解食欲差、恶心呕吐、腹泻等症状：藿香正气口服液或胶囊等。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒（2019-nCoV)感染的肺炎诊疗快速建议指南（完整版）\",\n" +
            "                \"content\": \"2临床表现2：乏力伴发热，推荐中成药：金花清感颗粒、连花清瘟胶囊（颗粒）、疏风解毒胶囊（颗粒）、防风通圣丸（颗粒）。临床表现：恶寒无汗，头痛身重，肢体烦疼，胸隔痞满，渴不欲饮，便沥不爽，溺短而黄。推荐处方：藿香正气散加减（《全国名医验案之类编》之阴湿伤表案）。组成：紫苏叶10 g、苍术15g、白芷10g、陈皮10g、羌活 10g、藿香10g（后下）、厚朴 10 g、防风10g、茯苓皮15g、通草10 g。推荐中成药：藿香正气胶囊、藿香正气水。临床表现：恶寒发热或无热，干咳，咽干，倦怠无力，胸闷，脘痞或呕恶，便唐。古质淡或淡红，苔白腻，脉濡。推荐处方：苍术 15 g、陈皮10 g、厚朴10 g、藿香10 g（后下）、草果6g、生麻黄6g、羌活10g、生姜10g、槟榔10g（后下）、蝉蜕10g、僵蚕10g、片姜黄10 g。临床表现：身热不退或往来寒热，咳嗽痰热，或有黄痰，腹胀便秘。胸闷气促，咳嗽憋喘，动则气喘，舌质红，苔黄腻或黄燥，脉滑数。推荐处方：杏仁10g、生石膏30g（先煎）、瓜萎30g、生大黄6g（后下）、生炙麻黄各6g、子 10 g、桃仁10 g、草果6g、槟榔10g，苍术10g推荐中成药：喜炎平注射液、而必净注射液。临床表现：身体壮热，胸闷气促，面色紫黑，唇色黑焦肿，神识昏迷。舌绛紫苔黄燥，脉洪大弦数。推荐处方：三黄石膏汤合升降散合解毒活血汤。组成：炙麻黄10 g、杏仁10 g、生石膏20-30 g、蝉衣 10 g、僵蚕 10g、姜黄10g、酒大黄10 g、黄芩 10 g、黄连5g、连翘 15 g、当归 10g、桃仁 10 g、赤芍 15g、生地15 g。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"血液净化室新型冠状病毒感染的防控措施详解\",\n" +
            "                \"content\": \"中关村肾病血液净化创新联盟18/39根据患者的病证和疾病的不同时期（初期一寒湿郁肺、中期一疫毒闭肺重症期一内闭外脱、恢复期一肺脾气虚），采用中成药或汤剂，进行中西医结合治疗。对于尚未确诊，在医学观察期的患者，表现为乏力伴胃肠不适者推荐使用藿香正气胶囊，对乏力伴发热者推荐使用金花清感颗粒、连花清瘟胶囊（颗粒）、疏风解毒胶囊（颗粒）、防风通圣丸（颗粒）等中成药。血液净化惠名建议监测血钾对维持性血液净化患者而言，当考虑为新型冠状病毒疑似病例后，建议应推迟透析，尽快在6小时取得核酸的确诊。对于确诊病例，可转当地有隔离条件的血液净化室进行透析。若当地医院没有条件在6小时内进行确诊的疑似病例，又急需透析，可在具备有效隔离条件和防护条件的定点医院隔离单间行床旁透析如果在血液透析治疗过程中检测到疑似或确诊感染的患者，医护人员应将患者戴上医用外科防护口罩或1N95型口罩，并将患者运送到隔离房间，并立即逐级上报，转移到专门收治感染患者并具有透析能力的指定医院或中心。如果疫情暴发影响的医院有隔离服务的能力，则应在单人、负压隔离间中使用专机对疑似或确诊的感染患者进行透析。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"湖南省新冠肺炎中医药防治方案（2022年第二版）\",\n" +
            "                \"content\": \"根据提供的资料，可得知参考中成药包括金花清感颗粒、连花清瘟颗粒、双黄连颗粒等中药；治疗的主要症状为纳差、大便沥、恶心欲呕、腹胀等，舌苔薄黄或黄腻，脉濡数；治法是清热化浊，理气运脾；主方为麻杏苡甘汤加味，参考方药包括知母、金银花、连翘等；儿童治疗方案为麻杏石甘汤加味，配合荆芥、芦根、桑叶等；针对不同症状的中成药有金花清感颗粒、藿香正气颗粒、双黄连颗粒等；治疗口服液、颗粒等剂型；另有静脉滴注的治疗方式，主要包括生脉散、三石汤等；治疗心脏病的中成药有血必净注射液、痰热清注射液等；针对神疲乏力等症状，推荐贞芪扶正颗粒、强力枇杷膏；医生可根据实际情况参考使用不同中成药方案。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新型冠状病毒肺炎中西医结合防治专家共识\",\n" +
            "                \"content\": \"心理干预:\\n\\t心态:\\n\\t\\t- 麻木、否认、愤怒、恐惧、焦虑、抑郁、失望、抱怨、失眠或攻击等\\n\\t\\t- 属于正常的应激反应\\n\\t\\t- 给予心理危机预防\\n\\t\\t- 隔离治疗的重要性和必要性\\n\\t\\t- 支持、安慰、宽容对待\\n\\t一般治疗:\\n\\t\\t- 卧床休息，加强支持治疗\\n\\t\\t- 注意水、电解质平衡\\n\\t\\t- 监测生命体征、指氧饱和度\\n\\t\\t- 监测血常规、尿常规、生化指标\\n中医防治:\\n\\t- 生活调摄、中医药、中医针灸预防\\n确诊病例治疗:\\n\\t清肺排毒汤:\\n\\t\\t- 适用范围\\n\\t\\t- 宣肺止咳、清热化湿、解毒祛邪\\n\\t\\t- 麻杏石甘汤、射干麻黄汤、小柴胡汤、五苓散加减方药\\n\\t\\t- 一般治疗\\n\\t\\t- 中医防治\\n\\t湿热郁肺证:\\n\\t\\t- 清热祛湿，宣肺平喘\\n\\t\\t- 麻否石甘汤合达原饮加减方药\\n\\t\\t- 抗病毒治疗\\n\\t\\t- α-干扰素治疗\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"儿童流行性感冒中西医结合防治专家共识\",\n" +
            "                \"content\": \"中成药推荐使用：小儿肺热咳喘口服液18、小儿咳喘颗粒（1)流感初期发热、鼻塞、流涕明显者，可给予四季抗病毒合剂20、小儿青翘颗粒\\\"、金银花口服液、抗感颗粒（儿童装)(2)流感时期高热、身痛、头痛明显者，可给予连花清瘟颗粒4；高热、咳嗽明显者，可给予金振口服液²5」、小儿肺热咳喘颗粒；高热、咽喉红肿疼痛、扁六灵解毒丸、金莲清热泡腾片、蓝芩口服液(3)流感伴便秘者,可给予芩香清解口服液小儿豉翘清热颗粒32；伴腹胀、厌食者，可给予神曲消食口服液33}；伴咳嗽、饮食积滞者，可给予小儿消积止咳口服液及用法见表3。7．1中医预防方案社区内有流感暴发流行，与流感人群有密切接触时可针对不同体质给予不同的中药方剂口服，同时也可给予悬挂中药香囊芳香避秽预防流感。此外，针对流感的易感人群平素也可给予穴位贴敷增强体质预防流感。组方1：银花、连翘、大青叶、苏叶各6g。适应人群：正常体质儿童。煎服方法：水煎至100～150mL，分2～3次口服，每日1剂，7～10剂为宜。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"小儿病毒性肺炎中医临床诊疗指南（修订）\",\n" +
            "                \"content\": \"用于风热闭肺证、痰热闭肺证（推荐级别：B级）（5）连花清瘟颗粒：每袋6g。1～6岁，每次3g；>6岁，每次6g。每日3次，口服。用于风热闭（6）玉屏风口服液：每支10mL。<1岁，每次3mL；1~5岁，每次5~10mL；6~14岁，每次10mL。每日3次，口服。用于肺脾气虚证（推荐级别：0级)O（7)安宫牛黄丸：①丸剂：每丸重3g。≤3岁，每次0．75g；4~6岁，每次1．5g。每日1次，口服。②散剂：每瓶装1．6g，≤3岁，每次0．4g；4~6岁，每次0．8g。每日1次，温开水送服。用于毒热闭肺证、邪陷厥阴证(推荐级别:C级)（1）喜炎平注射液：5～10mg·kg，最高剂量不超过250mg，每日1次，静脉滴注。用于风热闭肺证、痰热闭肺证、毒热闭肺证（推荐级别：A级）（2）痰热清注射液：0．3~0．5mL·kg-，最高剂量不超过20mL，每日1次，或遵医瞩，静脉滴注。用于风热闭肺证、痰热闭肺证（推荐级别：A级）（3）热毒宁注射液：3～5岁，最高剂量不超过10mL;6～10岁，每次10mL；11～13岁，每次15mL；14~17岁，每次20mL。每日1次，静脉滴注。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"新冠肺炎奥密克戎变异株中成药应用专家共识\",\n" +
            "                \"content\": \"安宫牛黄丸服法：口服，一次1丸，每日1次，疗程3~5天。苏合香丸服法：口服，一次1丸，每日1～2次，疗程3~5天。紫雪丹服法：口服日2次。注射液用法：参附注射液20～100mL、生脉注射液20~60mL、参麦注射液100mL溶于葡萄糖注射液或生理盐水250mL液体中静滴，一日2次，疗程7~10天。3．5核酸“长阳”患者（超过同期平均转阴时间）新冠肺炎核酸长期阳性患者（简称“长阳”）是指该新冠肺炎患者核酸转阴时间超过同期患者平均核酸转阴时间。一般可分为湿热恋肺证和正虚湿困证。无发热或低热，头晕，困倦，口苦，口干，口臭，食欲减退，腹胀，大便粘滞，舌质淡红，苔腻或黄，脉滑数或濡；或无症状患者古苔腻或黄，脉滑数或濡，乃湿热恋肺证。推荐中成药：宣肺败毒颗粒、化湿败毒颗粒、痰热清胶囊、连花清瘟颗粒（胶囊）、银马解毒颗粒。银马解毒颗粒服法：冲服，一次10g，一日2～3次，疗程7～14天。乏力，精神差，畏风，汗多，食欲不振，大便粘腻，舌质淡胖大，苔白，脉细无力；或无症状患者舌质淡胖大，苔白，脉细无力，乃正虚湿困证。推荐中成药：玉屏风口服液、健脾丸、人参健脾丸、附子理中丸。玉屏风口服液：口服，一次10mL，一日3次，疗程7~10天。健脾丸：口服，一次8丸，一日3次，疗程7～10天。人参健脾丸：口服，一次2丸，一日2次，疗程7~14天。附子理中丸：口服，一次8～12丸，一日3次，疗程7~14天。\"\n" +
            "            },\n" +
            "            {\n" +
            "                \"title\": \"慢性阻塞性肺疾病中西医结合管理专家共识（2023 版）\",\n" +
            "                \"content\": \"5．2．2．1．1风寒袭肺证症状：咳声重浊，喘息，呼吸气促，胸部胀闷，咳痰稀薄色白，常伴鼻塞，流清涕，头痛，肢体酸楚，恶寒发热，无汗等表证，舌苔薄白，脉浮或浮紧。治法：疏风散寒，宣肺止咳。方药：三汤合止嗽散加减。寒饮伏肺，风寒袭表可选小青龙汤散寒解表，温肺饮；饮郁化热可用小青龙加石膏汤加减。中成药：外感风寒早期恶寒发热，全身酸痛、流清涕可以选用九味羌活片、治伤风颗粒、荆防颗粒等；咳嗽可选用宣肺止嗽合剂、通宣理肺丸/口服液、三片；喘憋可以选桂龙咳喘灵胶囊、小青龙合剂等。黄或黏稠，喉燥咽痛，胸闷喘憋，常伴恶风身热，头痛肢楚，鼻流黄涕，口渴等表热证，舌苔薄黄，脉浮数或浮滑。治法：疏风清热，宣肺止咳。方药：桑菊饮加减。中成药：外感风热初期发热无汗咽痛，可以选用银翘解毒软胶囊/颗粒、金银花口服液、连花清瘟颗粒等：咳嗽咳黄痰可用肺力咳合剂/胶囊、无糖型强力枇杷露、急支糖浆、桑菊感冒片等。5．2．2．1．3痰湿蕴肺证症状：咳嗽反复发作，尤以晨起咳甚，咳声重浊，或喘而胸满闷室，甚则胸盈仰息，痰多，痰黏腻或稠厚成块，色白或带灰色，胸闷气憋，痰出则咳缓、憋闷减轻。常伴体倦，脘痞，腹胀，大便时唐，舌苔白腻，脉濡滑。治法：燥湿化痰，理气止咳。方药：麻杏二三汤加减。中成药：二陈丸、止咳橘红颗粒、痰咳净散、满山白颗粒、祛痰止咳颗粒等。\"\n" +
            "            }\n" +
            "        ],\n" +
            "        \"totalScore\": 23,\n" +
            "        \"clinicalDemandScore\": 5,\n" +
            "        \"clinicalPositioningScore\": 3,\n" +
            "        \"clinicalDemandOption\": \"填补本院用药目录空白\",\n" +
            "        \"clinicalPositioningContent\": \"连花清瘟胶囊是一种中成药，主要成分包括连翘、金银花等，主要用于治疗流感、普通感冒等呼吸道感染。其适应症中有提到可以缓解儿童的感冒症状，因此它也可用于儿童。在某些情况下，医生也可能会推荐给儿童使用。但需遵循医生的建议，注意用量和适应症。因此，本药品能被归类为治疗呼吸类传染病，并且也适合儿童使用，符合要求，得5分。\\n该药品缓解疾病过程中出现的各种不适症状\",\n" +
            "        \"evidenceRecommendationScore\": 10\n" +
            "    }\n" +
            "}";

    

    public void generateReportPc(HttpServletResponse response, String id) throws IOException, DocumentException {

        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "drug_score_tra");
        DrugInfoNew drugInfoNew = mongoTemplate.findById(jsonObjects.getString("drugId"), DrugInfoNew.class);
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        TrInheritanceEvaluationDto inheritanceEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrInheritanceEvaluationDto.class);
        TrClinicalEvaluationDto clinicalEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrClinicalEvaluationDto.class);
        TrSafetyEvaluationDto safetyEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrSafetyEvaluationDto.class);
        TrTechnologyEvaluationDto technologyEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrTechnologyEvaluationDto.class);
        TrMarketEvaluationDto marketEvaluation = JSONObject.parseObject(jsonObjects.toJSONString(), TrMarketEvaluationDto.class);
        TrInfoDto trInfoDto = new TrInfoDto();
        trInfoDto.setTrInheritanceEvaluationDto(inheritanceEvaluation);
        trInfoDto.setTrClinicalEvaluationDto(clinicalEvaluation);
        trInfoDto.setTrSafetyEvaluationDto(safetyEvaluation);
        trInfoDto.setTrTechnologyEvaluationDto(technologyEvaluation);
        trInfoDto.setTrMarketEvaluationDto(marketEvaluation);

        trInfoDto.getTrClinicalEvaluationDto().setTotalScore(jsonObjects.getDouble("trClinicalEvaluationTotalScore"));
//        trInfoDto.getTrMarketEvaluationDto().setPolicyAttributeScore();
        trInfoDto.getTrMarketEvaluationDto().setTotalScore(jsonObjects.getDouble("marketEvaluationTotalScore"));
        trInfoDto.getTrInheritanceEvaluationDto().setTotalScore(jsonObjects.getDouble("inheritanceEvaluationTotalScore"));
//        trInfoDto.getTrSafetyEvaluationDto().setCrowdRestrictionScore();
//        trInfoDto.getTrSafetyEvaluationDto().setSafetyInfoScore();
        trInfoDto.getTrSafetyEvaluationDto().setTotalScore(jsonObjects.getDouble("safetyEvaluationTotalScore"));
//        trInfoDto.getTrTechnologyEvaluationDto().setSuitabilityScore();
//        trInfoDto.getTrTechnologyEvaluationDto().setAdditionalZodiacScore();
        trInfoDto.getTrTechnologyEvaluationDto().setTotalScore(jsonObjects.getDouble("technologyEvaluationScore"));


        trInfoDto.setTotalScore();

        trInfoDto.setTitle(jsonObjects.getString("title"));
        trInfoDto.setDrugName(jsonObjects.getString("drugInfo"));

        String drugInfo = trInfoDto.getTitle();

        response.setHeader("Content-Disposition", "attachment;fileName=" + jsonObjects.getString("simpleTitle") + ".doc");
        ServletOutputStream outputStream = response.getOutputStream();
        Document document = new Document();
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);

        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        document.open();

        ClassPathResource classPathResource = new ClassPathResource("/static/logo.png");
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image logo = com.lowagie.text.Image.getInstance(bytes);
        logo.scaleAbsolute(100, 30);
        logo.setAlignment(Image.ALIGN_RIGHT);

        Paragraph headerParagraph = new Paragraph();
        headerParagraph.add(logo);
        headerParagraph.setAlignment(HeaderFooter.ALIGN_RIGHT);

        HeaderFooter header = new HeaderFooter(headerParagraph, false);
        header.setAlignment(HeaderFooter.ALIGN_RIGHT);
        header.setBorderWidth(0);

        document.setHeader(header);

        Paragraph paragraphTitle = createDataWordV1(jsonObjects.getString("simpleTitle"));
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
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
        String formattedDate = sdf.format(calendar.getTime());

        Paragraph headWord2 = createHeadWordV1(12, formattedDate, Element.ALIGN_LEFT);
        headWord2.setAlignment(Element.ALIGN_CENTER);
        headWord2.setSpacingBefore(9);
        headWord2.setSpacingAfter(8);
        document.add(headWord2);

        Paragraph headWord3 = createHeadWordV2(11, "本报告包含由 EviMed 模型 AI 生成的内容与人工编辑确认内容", Element.ALIGN_CENTER);
        headWord3.setSpacingBefore(9);
        document.add(headWord3);

        // 新开一页
        document.newPage();

        // 摘要
        Paragraph abstractTitle = createHeadWord(14, "摘要：", Element.ALIGN_LEFT);     // new Paragraph("摘要：", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        document.add(abstractTitle);
        Paragraph abstractContent = new Paragraph("目的 根据《河北省公立医疗机构中成药遴选评价表》对" + drugInfo + "进行临床综合评价。方法 该中成药遴选量表通过对传承评价（22分）、临床评价（25分）、安全评价（20分）、技术评价（14分）及市场评价（19分）5个方面内容，对药品进行临床综合评价归纳总结。结果 根据《河北省公立医疗机构中成药遴选评价表》：" + drugInfo + "最终得分为" + doubleToString(trInfoDto.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(abstractContent);

        // 评价目的
        Paragraph purposeTitle = createHeadWord(14, "一、评价目的", Element.ALIGN_LEFT);
        // new Paragraph("一、评价目的", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(purposeTitle);
        Paragraph purposeContent = new Paragraph("本研究通过传承评价、临床评价、安全评价、技术评价以及市场评价5个评价维度，进行量化打分，以期对进出医疗机构的中成药进行客观的遴选与评价。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(purposeContent);

        // 评价药品
        Paragraph drugTitle = createHeadWord(14, "二、评价药品", Element.ALIGN_LEFT); // new Paragraph("二、评价药品", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(drugTitle);
        Paragraph drugContent = createDataWord(drugInfo); // new Paragraph(drugInfo, new Font(Font.FontFamily.HELVETICA, 12, Font.NORMAL));
        document.add(drugContent);

        // 评价过程
        Paragraph processTitle = createHeadWord(14, "三、评价过程", Element.ALIGN_LEFT); // new Paragraph("三、评价过程", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(processTitle);
        Paragraph processContent = new Paragraph("本研究的研究方法主要是对" + drugInfo + "进行临床综合评估，根据《河北省公立医疗机构中成药遴选评价表》进行量化打分，其评估维度包括传承评价、临床评价、安全评价、技术评价以及市场评价。总分加和为100分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(processContent);

        // 评价结果
        Paragraph resultTitle = createHeadWord(14, "四、评价结果", Element.ALIGN_LEFT); // new Paragraph("四、评价结果", new Font(Font.FontFamily.HELVETICA, 16, Font.BOLD));
        document.add(resultTitle);
        Paragraph totalScoreParagraph = new Paragraph(drugInfo + "综合评价结果最终得分共计" + doubleToString(trInfoDto.getTotalScore()) + "分，其中传承评价最终得分" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分，临床评价最终得分" + doubleToString(clinicalEvaluation.getTotalScore()) + "分，安全评价最终得分" + doubleToString(safetyEvaluation.getTotalScore()) + "分，技术评价最终得分" + doubleToString(technologyEvaluation.getTotalScore()) + "分，市场评价最终得分" + doubleToString(marketEvaluation.getTotalScore()) + "分。", new Font(Font.HELVETICA, 12, Font.NORMAL));
        document.add(totalScoreParagraph);

        // 药学特性
        Paragraph pharmaceuticalTitle = new Paragraph("1、传承评价（共22分，得分：" + doubleToString(inheritanceEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        pharmaceuticalTitle.setSpacingBefore(10);
        pharmaceuticalTitle.setSpacingAfter(10);
        document.add(pharmaceuticalTitle);
        addSubItem(document, "1.1 组方来源", inheritanceEvaluation.getRecipeSourceContent(), inheritanceEvaluation.getRecipeSourceScore());
        addSubItemTitle(document, "1.2 理论支撑", inheritanceEvaluation.getTheorySupportScore());
        addSubItem(document, "1.2.1 中医药理论指导", inheritanceEvaluation.getTheoryGuidanceContent(), inheritanceEvaluation.getTheoryGuidanceScore());
        addSubItem(document, "1.2.2 君臣佐使配伍", inheritanceEvaluation.getTheoryCombinationContent(), inheritanceEvaluation.getTheoryCombinationScore());
        addSubItem(document, "1.2.3 君臣药的药性、归经与治疗目标是否相符", inheritanceEvaluation.getTheoryPathogenesisContent(), inheritanceEvaluation.getTheoryPathogenesisScore());
        addSubItem(document, "1.2.4 君臣药的炮制品选择与治疗目标是否相符", inheritanceEvaluation.getTheoryPotContent(), inheritanceEvaluation.getTheoryPotScore());


        addSubItemTitle(document, "1.3 病证结合", inheritanceEvaluation.getDiseaseCombinationScore());
        addSubItem(document, "1.3.1 疾病、证候、症状描述", inheritanceEvaluation.getDiseaseCombinationContent1(), inheritanceEvaluation.getDiseaseCombinationScore1());
        addSubItem(document, "1.3.2 疾病使用西医术语描述", inheritanceEvaluation.getDiseaseCombinationContent2(), inheritanceEvaluation.getDiseaseCombinationScore2());

        // 临床评价
        Paragraph clinicalTitle = new Paragraph("2、临床评价（共25分，得分：" + doubleToString(clinicalEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        clinicalTitle.setSpacingBefore(10);
        clinicalTitle.setSpacingAfter(10);
        document.add(clinicalTitle);
        addSubItem(document, "2.1 临床定位", clinicalEvaluation.getClinicalPositioningContent(), clinicalEvaluation.getClinicalPositioningScore());
        addSubItem(document, "2.2 临床研究", getEvidenceRecommendationContentByJson(jsonObjects.getJSONArray("clinicalResearchContent")), clinicalEvaluation.getClinicalResearchScore());
        addSubItem(document, "2.3 证据推荐", getEvidenceRecommendationContentByJson(jsonObjects.getJSONArray("evidenceRecommendationContent")), clinicalEvaluation.getEvidenceRecommendationScore());
        addSubItem(document, "2.4 临床需求", clinicalEvaluation.getClinicalDemandOption(), clinicalEvaluation.getClinicalDemandScore());
        if (StringUtils.isNotEmpty(clinicalEvaluation.getClinicalDemandContent())) {
            // 单独加一横
            Paragraph clinicalEvaluationInfo = createDataWord("原因：" + clinicalEvaluation.getClinicalDemandContent());
            document.add(clinicalEvaluationInfo);
        }

        // 安全评价
        Paragraph safetyTitle = new Paragraph("3、安全评价（共20分，得分：" + doubleToString(safetyEvaluation.getTotalScore()) + "分）", new Font(Font.HELVETICA, 14, Font.BOLD));
        safetyTitle.setSpacingBefore(10);
        safetyTitle.setSpacingAfter(10);
        document.add(safetyTitle);
        // 安全信息评价
        Paragraph safetyInfoTitle = createHeadWord(12, "3.1 安全信息评价（" + doubleToString(safetyEvaluation.getSafetyInfoScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.1安全信息评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        safetyInfoTitle.setSpacingBefore(10);
        safetyInfoTitle.setSpacingAfter(10);
        document.add(safetyInfoTitle);
        addSubSubItem(document, "3.1.1 不良反应、禁忌等描述", safetyEvaluation.getAdverseReactionContent(), safetyEvaluation.getAdverseReactionScore());
        addSubSubItem(document, "3.1.2 说明书中警示语或注意事项", safetyEvaluation.getWarningNoteContent(), safetyEvaluation.getWarningNoteScore());
        addSubSubItem(document, "3.1.3 辅料", String.valueOf(safetyEvaluation.getExcipient()), safetyEvaluation.getExcipientScore());
        addSubSubItem(document, "3.1.4 安全性再评价", getEvidenceRecommendationContentByJson(jsonObjects.getJSONArray("safetyReevaluationContent")), safetyEvaluation.getSafetyReevaluationScore());
        // 人群限制
        Paragraph populationRestrictionTitle = createHeadWord(12, "3.2 人群限制（" + doubleToString(safetyEvaluation.getCrowdRestrictionScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("3.2人群限制（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        populationRestrictionTitle.setSpacingBefore(10);
        populationRestrictionTitle.setSpacingAfter(10);
        document.add(populationRestrictionTitle);
        addSubSubItem(document, "3.2.1 儿童用药", safetyEvaluation.getPediatricDrugUseContent(), safetyEvaluation.getPediatricDrugUseScore());
        addSubSubItem(document, "3.2.2 妊娠期妇女用药", safetyEvaluation.getPregnancyDrugUseContent(), safetyEvaluation.getPregnancyDrugUseScore());
        addSubSubItem(document, "3.2.3 哺乳期妇女用药", safetyEvaluation.getLactationDrugUseContent(), safetyEvaluation.getLactationDrugUseScore());
        addSubSubItem(document, "3.2.4 肝功能异常者用药", safetyEvaluation.getLiverDysfunctionDrugUseContent(), safetyEvaluation.getLiverDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.5 肾功能异常者用药", safetyEvaluation.getKidneyDysfunctionDrugUseContent(), safetyEvaluation.getKidneyDysfunctionDrugUseScore());
        addSubSubItem(document, "3.2.6 运动员用药", safetyEvaluation.getAthleteDrugUseContent(), safetyEvaluation.getAthleteDrugUseScore());
        // 不良反应分级
        addSubItem(document, "3.3 不良反应分级", safetyEvaluation.getAdverseReactionStratificationContent(), safetyEvaluation.getAdverseReactionStratificationScore());

        // 技术评价
        Paragraph technologyTitle = createHeadWord(14, "4、技术评价（共14分，得分：" + doubleToString(technologyEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT); // new Paragraph("4、技术评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        technologyTitle.setSpacingBefore(10);
        technologyTitle.setSpacingAfter(10);
        document.add(technologyTitle);
        // 适宜性
        Paragraph suitabilityTitle = createHeadWord(12, "4.1 适宜性（" + doubleToString(technologyEvaluation.getSuitabilityScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("4.1适宜性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        suitabilityTitle.setSpacingBefore(10);
        suitabilityTitle.setSpacingAfter(10);
        document.add(suitabilityTitle);
        addSubSubItem(document, "4.1.1 给药频次", technologyEvaluation.getAdministrationFrequencyContent(), technologyEvaluation.getAdministrationFrequencyScore());
        addSubSubItem(document, "4.1.2 包装规格", technologyEvaluation.getPackagingSpecificationOption(), technologyEvaluation.getPackagingSpecificationScore());
        addSubSubItem(document, "4.1.3 采用大包装", technologyEvaluation.getLargePackageAdoptionOption(), technologyEvaluation.getLargePackageAdoptionScore());
        addSubSubItem(document, "4.1.4 单次用量", technologyEvaluation.getSingleDoseOption(), technologyEvaluation.getSingleDoseScore());
        addSubSubItem(document, "4.1.5 疗程", technologyEvaluation.getCourseOfTreatmentContent(), technologyEvaluation.getCourseOfTreatmentScore());
        addSubSubItem(document, "4.1.6 贮藏", technologyEvaluation.getStorageContent(), technologyEvaluation.getStorageScore());
        addSubSubItem(document, "4.1.7 有效期", String.valueOf(technologyEvaluation.getValidityPeriodContent()), technologyEvaluation.getValidityPeriodScore());
        addSubItem(document, "4.2 国家中药保护品种", String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), technologyEvaluation.getNationalTraditionalChineseMedicineProtectionScore());
        // 附加属性
        Paragraph additionalAttributesTitle = createHeadWord(12, "4.3 附加属性（" + doubleToString(technologyEvaluation.getAdditionalZodiacScore()) + "）", Element.ALIGN_LEFT); // new Paragraph("4.3附加属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        additionalAttributesTitle.setSpacingBefore(10);
        additionalAttributesTitle.setSpacingAfter(10);
        document.add(additionalAttributesTitle);
        addSubSubItem(document, "4.3.1 中国药典", String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), technologyEvaluation.getChinesePharmacopoeiaScore());
        addSubSubItem(document, "4.3.2 专利", technologyEvaluation.getPatentNumber(), technologyEvaluation.getPatentScore());
        addSubSubItem(document, "4.3.3 独家品种", technologyEvaluation.getExclusiveVarietyInfo(), technologyEvaluation.getExclusiveVarietyScore());


        // 市场评价
        Paragraph marketTitle = createHeadWord(14, "5、市场评价（共19分，得分：" + doubleToString(marketEvaluation.getTotalScore()) + "分）", Element.ALIGN_LEFT);// new Paragraph("5、市场评价（本项总得分）", new Font(Font.FontFamily.HELVETICA, 14, Font.BOLD));
        marketTitle.setSpacingBefore(10);
        marketTitle.setSpacingAfter(10);
        document.add(marketTitle);
        addSubItem(document, "5.1 市场独特性", marketEvaluation.getMarketUniquenessOption(), marketEvaluation.getMarketUniquenessScore());
        // 单独加一横
        if (StringUtils.isNotEmpty(marketEvaluation.getMarketUniquenessContent())) {
            Paragraph marketUniquenessInfo = createDataWord("原因：" + marketEvaluation.getMarketUniquenessContent());
            document.add(marketUniquenessInfo);
        }
        addSubItemTitle(document, "5.2 经济性", marketEvaluation.getEconomicScore());
        addSubItem(document, "5.2.1 日均治疗费用", marketEvaluation.getDailyTreatmentCostOption(), marketEvaluation.getDailyTreatmentCostScore());
        addSubItem(document, "5.2.2 经济学优势", getEvidenceRecommendationContentByJson(jsonObjects.getJSONArray("economicAdvantageOption")), marketEvaluation.getEconomicAdvantageScore());

        // 政策属性
        Paragraph policyAttributeTitle = createHeadWord(12, "5.3 政策属性（" + doubleToString(marketEvaluation.getPolicyAttributeScore()) + "）", Element.ALIGN_LEFT);// new Paragraph("5.3政策属性（本项总得分）", new Font(Font.FontFamily.HELVETICA, 12, Font.BOLD));
        policyAttributeTitle.setSpacingBefore(10);
        policyAttributeTitle.setSpacingAfter(10);
        document.add(policyAttributeTitle);
        addSubSubItem(document, "5.3.1 国家基本药物", marketEvaluation.getNationalEssentialDrugsRequirement(), marketEvaluation.getNationalEssentialDrugsScore());
        addSubSubItem(document, "5.3.2 国家医保药品", marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), marketEvaluation.getNationalMedicalInsuranceDrugsScore());
        addSubSubItem(document, "5.3.3 集中带量采购药品或国家谈判品种（协议期内）", marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), marketEvaluation.getCentralizedVolumePurchasingDrugsScore());
        addSubItemTitle(document, "5.4 生产企业状况", technologyEvaluation.getProductionEnterpriseStatusScore());
        addSubItem(document, "5.4.1 生产企业", technologyEvaluation.getProductionEnterpriseContent(), technologyEvaluation.getProductionEnterpriseScore());
        addSubItem(document, "5.4.2 独立的GAP种植基地或全流程质量可追溯体系", technologyEvaluation.getOwnPlantingBaseOption(), technologyEvaluation.getOwnPlantingBaseScore());


        document.close();
    }

    // double转为string类型，去除多余的0，比如1.0则显示1
    private String doubleToString(double x) {
        String s = String.valueOf(x);
        if (s.contains(".0")) {
            return s.substring(0, s.length() - 2);
        } else if (s.contains(".00")) {
            return s.substring(0, s.length() - 3);
        } else if (s.contains(".") && s.endsWith("0")) {
            return s.substring(0, s.length() - 1);
        }
        return s;
    }


    // 辅助方法：添加子项内容
    private void addSubItem(Document document, String title, String content, double score) throws DocumentException, IOException {
        Paragraph subItemTitle = createHeadSecondWord(title + "（" + doubleToString(score) + "）");
        document.add(subItemTitle);
        Paragraph subItemContent = createDataWord(content);
        document.add(subItemContent);
    }


    private void addSubItemTitle(Document document, String title, double score) throws DocumentException, IOException {
        Paragraph subItemTitle = createHeadSecondWord(title + "（" + doubleToString(score) + "）");
        document.add(subItemTitle);


    }

    // 辅助方法：添加子子项内容
    private void addSubSubItem(Document document, String title, String content, double score) throws DocumentException, IOException {
        Paragraph subSubItemTitle = createHeadSecondWord(title + "（" + doubleToString(score) + "）");
        document.add(subSubItemTitle);
        Paragraph subSubItemContent = createDataWord(content);
        document.add(subSubItemContent);
    }

    // 辅助方法：获取证据推荐内容（处理多个证据推荐项）
    private String getEvidenceRecommendationContent(TrClinicalEvaluationDto clinicalEvaluation) {
        StringBuilder content = new StringBuilder();
        int counter = 1; // 初始化计数器
        for (TrClinicalEvaluationDto.EvidenceItem item : clinicalEvaluation.getEvidenceItems()) {
            content.append("(").append(counter).append(") ").append(item.getTitle()).append(":\n ").append(item.getContent()).append("\n");
            counter++; // 每次循环后计数器加1
        }
        return content.toString();
    }

    private String getEvidenceRecommendationContentByJson(JSONArray clinicalEvaluation) {
        StringBuilder content = new StringBuilder();
        int counter = 1; // 初始化计数器
        if (clinicalEvaluation == null) {
            return "未找到相关内容";
        }
        for (TrClinicalEvaluationDto.EvidenceItem item : clinicalEvaluation.toJavaList(TrClinicalEvaluationDto.EvidenceItem.class)) {
            content.append("(").append(counter).append(") ").append(item.getTitle()).append(":\n ").append(item.getContent()).append("\n");
            counter++; // 每次循环后计数器加1
        }
        return content.toString();
    }

    // 计算总得分

}
