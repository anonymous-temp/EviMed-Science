package com.sentum.evidencecomprehensive.utils;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.feign.FormulaFeign;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * 远程调用检索中台
 */
@Component
public class FormulaFeignUtils {
    @Autowired
    private FormulaFeign formulaFeign;
    public static FormulaFeign formula;

    @PostConstruct
    public void getFineScreenFeign(){
        formula = this.formulaFeign;
    }

    public static String formula(String query, Integer type) {
        JSONObject dataFormula = new JSONObject();
        dataFormula.put("query", query);
        dataFormula.put("type", type);
        dataFormula.put("other", 2);
        try {
            return formula.formula(dataFormula);
        } catch (Exception e) {
            return "";
        }
    }
}
