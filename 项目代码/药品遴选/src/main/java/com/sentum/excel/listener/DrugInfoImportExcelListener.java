package com.sentum.excel.listener;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.excel.context.AnalysisContext;
import com.alibaba.excel.event.AnalysisEventListener;
import com.sentum.excel.bean.DrugInfoExcelBean;
import com.sentum.excel.manager.DrugInfoImportManager;
import com.sentum.pojo.DrugAndIndicationIndex;
import com.sentum.pojo.DrugInfo;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;

import java.sql.Struct;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/**
 * @Description:
 */
public class DrugInfoImportExcelListener extends AnalysisEventListener<DrugInfoExcelBean> {
    
    private final List<DrugInfoExcelBean> drugExcelBeanInfos = new ArrayList<>();
    private final DrugInfoImportManager drugInfoImportManager;
    
    public DrugInfoImportExcelListener(DrugInfoImportManager drugInfoImportManager) {
        this.drugInfoImportManager = drugInfoImportManager;
    }

    /**
     * excel 的每条数据都会经过这里 这里可以做 valiadation 校验excel等
     * @param drugInfoExcelBean
     * @param analysisContext
     */
    @Override
    public void invoke(DrugInfoExcelBean drugInfoExcelBean, AnalysisContext analysisContext) {
        drugExcelBeanInfos.add(drugInfoExcelBean);
    }

    /**
     * 进行数据的导入等处理
     * @param analysisContext
     */
    @Override
    public void doAfterAllAnalysed(AnalysisContext analysisContext) {
        drugInfoImportManager.saveDrugInfo(drugExcelBeanInfos);
    }
}
