package com.sentum.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.DrugEvaluation;
import com.sentum.pojo.vo.DataResult;
import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;

@Service
public interface VaeService {


    Object guidePanel(String drugId, String disease ,String id, HttpServletResponse response, String scaleId);


     void guidePanelFor(String scaleId);


     Object getPanelFor(String scaleId);

    String option1();
    String option2();
    String option3();
    String option4();
    String option5();


    DataResult save(JSONObject jsonObject);

    JSONObject getReport(String reportId);



    void download(String reportId, HttpServletResponse response);

    /**
     * 导出药品评估数据为Excel
     * @param evaluation 药品评估数据
     * @param response HTTP响应对象
     * @throws IOException IO异常
     */
    void exportToExcel(DrugEvaluation evaluation, HttpServletResponse response) throws IOException;

    /**
     * 获取药品评估数据
     * @return 药品评估数据对象
     */
    DrugEvaluation getDrugEvaluationData(String reportId);



}
