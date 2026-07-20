package com.sentum.evidencecomprehensive.excel.listener;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.excel.context.AnalysisContext;
import com.alibaba.excel.event.AnalysisEventListener;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.mongo.CdeCollect;
import com.sentum.evidencecomprehensive.excel.bean.MedicalBatchImportExcelBean;
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
public class MedicaImportExcelListener extends AnalysisEventListener<MedicalBatchImportExcelBean> {

    private static final int BATCH_COUNT = 500;
    private final List<MedicalBatchImportExcelBean> medicalBatchImportExcelBeans = new ArrayList<>();
    private final Map<Integer, List<String>> errorMessageMap = new HashMap<>();
    private final Set<Integer> successCount = new HashSet<>();
    private final Validator validator;

    public MedicaImportExcelListener() {
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
    public void invoke(MedicalBatchImportExcelBean data, AnalysisContext context) {
        int rowNumber = context.readRowHolder().getRowIndex() + 1;
        Set<ConstraintViolation<MedicalBatchImportExcelBean>> constraintViolationSet = validator.validate(data);

        if (CollUtil.isNotEmpty(constraintViolationSet)) {
            constraintViolationSet.forEach(violation -> addErrorMessage(rowNumber, violation.getMessage()));
        } else {
            String payLimit = data.getPayLimit();
            if (StrUtil.isNotBlank(payLimit)) {
                data.setPayLimit(payLimit.replaceAll("\\n", ""));
            }
            medicalBatchImportExcelBeans.add(data);
        }
    }


    // 获取导入时 存在的错误信息
    public List<MedicalBatchImportExcelBean> getData() {
        return medicalBatchImportExcelBeans;
    }

    /**
     * 所有数据解析完成了 都会来调用
     */
    @Override
    public void doAfterAllAnalysed(AnalysisContext context) {
        if (CollUtil.isNotEmpty(medicalBatchImportExcelBeans)) {
            ReleaseMongoUtil.mongo.insert(medicalBatchImportExcelBeans, CdeCollect.MedicalInsurance.class);
        }
    }
}
