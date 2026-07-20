package com.sentum.evidencecomprehensive.excel.listener;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.excel.context.AnalysisContext;
import com.alibaba.excel.event.AnalysisEventListener;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.excel.bean.SelfUseBatchImportExcelBean;
import com.sentum.evidencecomprehensive.excel.manager.SelfUseImportExcelManager;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import lombok.extern.slf4j.Slf4j;

import javax.validation.ConstraintViolation;
import javax.validation.Validation;
import javax.validation.Validator;
import java.util.*;

/**
 * 用户信息 & 密码修改 批量处理 监听处理
 */
@Slf4j
public class SelfUseImportExcelListener extends AnalysisEventListener<SelfUseBatchImportExcelBean> {

    private static final int BATCH_COUNT = 500;
    private final List<SelfUseBatchImportExcelBean> selfUseBatchImportExcelBeans = new ArrayList<>();
    private final Map<Integer, List<String>> errorMessageMap = new HashMap<>();
    private final Set<Integer> successCount = new HashSet<>();
    private final SelfUseImportExcelManager manager;
    private final Validator validator;
    private final FineScreenFeign fineScreenFeign;

    public SelfUseImportExcelListener(SelfUseImportExcelManager manager, FineScreenFeign fineScreenFeign) {
        this.manager = manager;
        this.fineScreenFeign = fineScreenFeign;
        this.validator = Validation.buildDefaultValidatorFactory().getValidator();
    }

    // 获取导入时 存在的错误信息
    public String getErrorMessage() {
        List<String> errorMessageList = new ArrayList<>();
        if (CollUtil.isNotEmpty(errorMessageMap)) {
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

    private void addSuccessCount(Integer key) {
        successCount.add(key);
    }

    public Integer getSuccessCount() {
        if (CollUtil.isNotEmpty(successCount)) {
            return successCount.size();
        }
        return 0;
    }

    /**
     * 这个每一条数据解析都会来调用
     *
     * @param data    one row value. Is is same as {@link AnalysisContext#readRowHolder()}
     * @param context   excel 信息
     */
    @Override
    public void invoke(SelfUseBatchImportExcelBean data, AnalysisContext context) {
        int rowNumber = context.readRowHolder().getRowIndex() + 1;
        Set<ConstraintViolation<SelfUseBatchImportExcelBean>> constraintViolationSet = validator.validate(data);

        if (CollUtil.isNotEmpty(constraintViolationSet)) {
            constraintViolationSet.forEach(violation -> addErrorMessage(rowNumber, violation.getMessage()));
        } else {
            String paperId = data.getPaperId();
            if (StrUtil.isNotBlank(paperId) && !"无".equals(paperId)) {
                MongoLiterature mongoLiterature = fineScreenFeign.paper(paperId);
//                MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findById(paperId, MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
                assert mongoLiterature != null;
                List<Integer> type = mongoLiterature.getLastNewType();
                data.setAuthor(String.join("；", mongoLiterature.getAuthor()));
                data.setYear(mongoLiterature.getYear());
                if (type.contains(12)) {
                    if (StrUtil.isNotBlank(mongoLiterature.getEconomicsIC())) {
                        data.setContrastMeasure(mongoLiterature.getEconomicsIC());
                    }
                    if (StrUtil.isNotBlank(mongoLiterature.getEconomicsResult())) {
                        data.setResult(mongoLiterature.getEconomicsResult());
                    }
                    if (StrUtil.isNotBlank(mongoLiterature.getEconomicsConclusion())) {
                        data.setConclusion(mongoLiterature.getEconomicsConclusion());
                    }
                } else {
                    if (CollUtil.isNotEmpty(mongoLiterature.getIc())) {
                        data.setContrastMeasure(String.join("；", mongoLiterature.getIc()));
                    }
                    if (StrUtil.isNotBlank(mongoLiterature.getResult())) {
                        data.setResult(mongoLiterature.getResult());
                    }
                    if (StrUtil.isNotBlank(mongoLiterature.getConclusion())) {
                        data.setConclusion(mongoLiterature.getConclusion());
                    }
                }
                selfUseBatchImportExcelBeans.add(data);
            }
        }
    }


    // 获取导入时 存在的错误信息
    public List<SelfUseBatchImportExcelBean> getData() {
        return selfUseBatchImportExcelBeans;
    }

    /**
     * 所有数据解析完成了 都会来调用
     */
    @Override
    public void doAfterAllAnalysed(AnalysisContext context) {
        // 只要存在错误数据，则整个文件数据都不导入。
//        manager.saveUserInfo(excelBeanList);
//        if (errorMessageMap.isEmpty()) {
//            manager.saveUserInfo(excelBeanList);
//        }
    }
}
