package com.sentum.evidencecomprehensive.excel.listener;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.excel.context.AnalysisContext;
import com.alibaba.excel.event.AnalysisEventListener;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.excel.bean.ReportBatchImportExcelBean;
import com.sentum.evidencecomprehensive.excel.manager.ReportImportExcelManager;
import com.sentum.evidencecomprehensive.pojo.dto.ConditionDto;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.service.SuperManualReportService;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.collections.MapUtils;
import org.apache.commons.lang3.StringUtils;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.validation.ConstraintViolation;
import javax.validation.Validation;
import javax.validation.Validator;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * 批量生成报告 批量处理 监听处理
 */
@Slf4j
public class ReportImportExcelListener extends AnalysisEventListener<ReportBatchImportExcelBean> {

    private final List<JSONObject> conditionUseS = new ArrayList<>();
    private final List<ReportBatchImportExcelBean> selfUseBatchImportExcelBeans = new ArrayList<>();
    private final Map<Integer, List<String>> errorMessageMap = new HashMap<>();
    private final ReportImportExcelManager manager;
    private final Validator validator;
    private final RetrievalService retrievalService;
    private final SuperManualReportService superManualReportService;
    private final long userId;
    private final HttpServletRequest request;
    private final HttpServletResponse response;
    private final int batchSize = 1000;
    private Executor excelExecutor;

    // 定义线程池参数
    int corePoolSize = 5; // 核心线程数
    int maximumPoolSize = 5; // 最大线程数
    long keepAliveTime = 5000; // 空闲线程存活时间，单位毫秒
    TimeUnit unit = TimeUnit.MILLISECONDS; // 时间单位
    BlockingQueue<Runnable> workQueue = new LinkedBlockingQueue<>(batchSize); // 任务队列
    // 创建自定义线程池
    
    ThreadPoolExecutor executor = new ThreadPoolExecutor(
            corePoolSize,
            maximumPoolSize,
            keepAliveTime,
            unit,
            workQueue
    );
    
    public ReportImportExcelListener(ReportImportExcelManager manager, RetrievalService retrievalService, SuperManualReportService superManualReportService, long userId, HttpServletRequest request, HttpServletResponse response, Executor excelExecutor) {
        this.manager = manager;
        this.retrievalService = retrievalService;
        this.superManualReportService = superManualReportService;
        this.userId = userId;
        this.request = request;
        this.response = response;
        this.excelExecutor = excelExecutor;
        this.validator = Validation.buildDefaultValidatorFactory().getValidator();
    }

    // 获取导入时 存在的错误信息
    public String getErrorMessage() {
        List<String> errorMessageList = new ArrayList<>();
        if (MapUtils.isNotEmpty(errorMessageMap)) {
            errorMessageMap.forEach((k, v) -> errorMessageList.add("第" + k + "行：" + CollUtil.join(v, Constants.PAD_COMMA)));
        }
        return CollUtil.join(errorMessageList, Constants.PAD_SEMICOLON);
    }

    // 添加导入时 存在的错误信息
    private void addErrorMessage(Integer key, String msg) {
        if (!errorMessageMap.containsKey(key)) {
            errorMessageMap.put(key, new ArrayList<>());
        }
        errorMessageMap.get(key).add(msg);
    }

    /**
     * 这个每一条数据解析都会来调用
     *
     * @param data    one row value. Is is same as {@link AnalysisContext#readRowHolder()}
     * @param context   excel 信息
     */
    @Override
    public void invoke(ReportBatchImportExcelBean data, AnalysisContext context) {
        int rowNumber = context.readRowHolder().getRowIndex() + 1;
        Set<ConstraintViolation<ReportBatchImportExcelBean>> constraintViolationSet = validator.validate(data);

        if (CollectionUtils.isNotEmpty(constraintViolationSet)) {
            constraintViolationSet.forEach(violation -> addErrorMessage(rowNumber, violation.getMessage()));
        } else {
            CompletableFuture.runAsync(() -> {
                String p1 = data.getP1();
                String p1Expanded = data.getP1Expanded();
                String p2 = data.getP2();
                String p2Expanded = data.getP2Expanded();
                String p3 = data.getP3();
                String p3Expanded = data.getP3Expanded();

                String i1 = data.getI1();
                String i1Expanded = data.getI1Expanded();
                String i2 = data.getI2();
                String i2Expanded = data.getI2Expanded();
                String i3 = data.getI3();
                String i3Expanded = data.getI3Expanded();

                JSONObject synonymI = retrievalService.synonym(i1, 1, 1);
                JSONObject synonymI2 = null;
                if (StringUtils.isNotBlank(i2)) {
                    synonymI2 = retrievalService.synonym(i2, 1, 1);
                }
                JSONObject synonymI3 = null;
                if (StringUtils.isNotBlank(i3)) {
                    synonymI3 = retrievalService.synonym(i3, 1, 1);
                }

                JSONObject synonymP1 = retrievalService.synonym(p1, 2, 1);
                JSONObject synonymP2 = null;
                if (StringUtils.isNotBlank(p2)) {
                    synonymP2 = retrievalService.synonym(p2, 2, 1);
                }
                JSONObject synonymP3 = null;
                if (StringUtils.isNotBlank(p3)) {
                    synonymP3 = retrievalService.synonym(p3, 2, 1);
                }
                
                ConditionDto condition = new ConditionDto();
                List<Drug> drugs = new ArrayList<>();
                Drug drug = getDrug(synonymI, i1, i1Expanded);
                drugs.add(drug);
                condition.setDrugs(drugs);

                if (Objects.nonNull(synonymI2)) {
                    Drug drug1 = new Drug();
                    drug1.setStatus(2);
                    drugs.add(drug1);
                    drugs.add(getDrug(synonymI2, i2, i2Expanded));
                }
                if (Objects.nonNull(synonymI3)) {
                    Drug drug1 = new Drug();
                    drug1.setStatus(2);
                    drugs.add(drug1);
                    drugs.add(getDrug(synonymI3, i3, i3Expanded));
                }

                // 病
                List<Disease> diseases = new ArrayList<>();
                Disease disease = getDisease(synonymP1, p1, p1Expanded);
                diseases.add(disease);

                if (Objects.nonNull(synonymP2)) {
                    Disease disease1 = new Disease();
                    disease1.setStatus(2);
                    diseases.add(disease1);
                    diseases.add(getDisease(synonymP2, p2, p2Expanded));
                }
                if (Objects.nonNull(synonymP3)) {
                    Disease disease1 = new Disease();
                    disease1.setStatus(2);
                    diseases.add(disease1);
                    diseases.add(getDisease(synonymP3, p3, p3Expanded));
                }

                condition.setDiseases(diseases);
                condition.setOutcomes(new ArrayList<>());
                condition.setInterventions(new ArrayList<>());
                condition.setId("");
                condition.setEnJournal(Collections.singletonList("不限"));
                condition.setZhJournal(Collections.singletonList("不限"));
                condition.setGuideStartYear("不限");
                condition.setGuideEndYear("至今");
                condition.setLiteratureStartYear("不限");
                condition.setLiteratureEndYear("至今");
                condition.setIsTranslate(1);
                condition.setStudyType(Arrays.asList(0, 1, 2, 14, 3, 4, 5, 6, 7, 8, 11, 9, 10, 13));

                JSONObject conditionUse = retrievalService.saveCondition(condition, userId, request);
                if (Objects.nonNull(conditionUse)) {
                    String conditionId = conditionUse.getString("id");
                    log.info("i {} p1 {} p2 {} p3 {} 报告 id 为 {}", i1, p1, p2, p3, conditionId);
                    superManualReportService.createPc(conditionId, userId, "2", "pc", "verifyToken", request);
                    superManualReportService.downloadPc(conditionId, "pc", response, "excel");
                }
            }, excelExecutor);
        }
    }

    private static Drug getDrug(JSONObject synonymI, String i1, String expanded) {
        Drug drug = new Drug();
        if (Objects.nonNull(synonymI)) {
            JSONObject en = synonymI.getJSONObject("en");
            HashSet<String> enSynonym = JSON.parseObject(JSON.toJSONString(en.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> enSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(enSynonym)) {
                enSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    enSynonyms.add(wordStatus);
                });
            }
            drug.setEnSynonym(enSynonyms);
            
            String enName = en.getString("name");
            drug.setEnWord(enName);

            JSONObject zh = synonymI.getJSONObject("zh");
            HashSet<String> zhSynonym = JSON.parseObject(JSON.toJSONString(zh.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> zhSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(zhSynonym)) {
                zhSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    zhSynonyms.add(wordStatus);
                });
            }
            drug.setZhSynonym(zhSynonyms);
            String zhName = en.getString("name");
            drug.setZhWord(zhName);
            
            
            JSONObject other = synonymI.getJSONObject("other");
            Set<String> otherSynonym = JSON.parseObject(JSON.toJSONString(other.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> otherSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(otherSynonym)) {
                otherSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    otherSynonyms.add(wordStatus);
                });
            }
            
            if (StringUtils.isNotBlank(expanded)) {
                List<WordStatus> expandeds = Arrays.stream(expanded.split("￥")).map(o -> new WordStatus(o, true)).collect(Collectors.toList());
                otherSynonyms.addAll(expandeds);
            }
            drug.setOtherSynonym(otherSynonyms);
            
            drug.setExpandSynonym("");
            drug.setStatus(1);
            drug.setWord(i1);
        }
        return drug;
    }

    private static Disease getDisease(JSONObject synonymP, String p1, String expanded) {
        Disease disease = new Disease();
        if (Objects.nonNull(synonymP)) {
            JSONObject en = synonymP.getJSONObject("en");
            HashSet<String> enSynonym = JSON.parseObject(JSON.toJSONString(en.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> enSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(enSynonym)) {
                enSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    enSynonyms.add(wordStatus);
                });
            }
            disease.setEnSynonym(enSynonyms);

            String enName = en.getString("name");
            disease.setEnWord(enName);

            JSONObject zh = synonymP.getJSONObject("zh");
            HashSet<String> zhSynonym = JSON.parseObject(JSON.toJSONString(zh.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> zhSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(zhSynonym)) {
                zhSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    zhSynonyms.add(wordStatus);
                });
            }
            disease.setZhSynonym(zhSynonyms);
            String zhName = zh.getString("name");
            disease.setZhWord(zhName);

            JSONObject other = synonymP.getJSONObject("other");
            HashSet<String> otherSynonym = JSON.parseObject(JSON.toJSONString(other.getObject("synonym", new TypeReference<HashSet<String>>() {})), new TypeReference<HashSet<String>>() {});
            List<WordStatus> otherSynonyms = new ArrayList<>();
            if (CollectionUtils.isNotEmpty(otherSynonym)) {
                otherSynonym.forEach(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    otherSynonyms.add(wordStatus);
                });
            }
            if (StringUtils.isNotBlank(expanded)) {
                List<WordStatus> expandeds = Arrays.stream(expanded.split("￥")).map(o -> new WordStatus(o, true)).collect(Collectors.toList());
                otherSynonyms.addAll(expandeds);
            }
            disease.setOtherSynonym(otherSynonyms);

            disease.setExpandSynonym("");
            disease.setStatus(1);
            disease.setWord(p1);
        }
        return disease;
    }


    // 获取导入时 存在的错误信息
    public List<ReportBatchImportExcelBean> getData() {
        return selfUseBatchImportExcelBeans;
    }

    /**
     * 所有数据解析完成了 都会来调用
     */
    @Override
    public void doAfterAllAnalysed(AnalysisContext context) {
        // 只要存在错误数据，则整个文件数据都不导入。
        generateReport(conditionUseS);
        if (errorMessageMap.isEmpty()) {
            generateReport(conditionUseS);
        }
    }

    private void generateReport(List<JSONObject> conditionUseS) {

        if (CollectionUtils.isNotEmpty(conditionUseS)) {
            for (int i = 0; i < conditionUseS.size(); i++) {
                int taskId = i;
                JSONObject conditionUse = conditionUseS.get(i);
                String conditionId = conditionUse.getString("id");
                executor.execute(() -> {
                    log.info("任务 {}, 正在执行，线程名: {}", taskId, Thread.currentThread().getName());
                    try {
                        superManualReportService.createPc(conditionId, userId, "2", "pc", "verifyToken", request);
                        superManualReportService.downloadPc(conditionId, "pc", response, "excel");
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    log.info("任务 {}, 执行完毕!!!", taskId);
                });
            }
        }
        
        // 关闭线程池
        executor.shutdown();
        try {
            // 等待所有任务完成
            if (!executor.awaitTermination(60, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
        }
    }
    
}
