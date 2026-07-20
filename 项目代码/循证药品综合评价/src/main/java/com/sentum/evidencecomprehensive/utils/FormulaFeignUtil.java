package com.sentum.evidencecomprehensive.utils;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.feign.FormulaFeign;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * 远程调用检索中台
 */
@Slf4j
@Component
public class FormulaFeignUtil {
    @Autowired
    private FormulaFeign formulaFeign;
    public static FormulaFeign formula;

    @PostConstruct
    public void getFineScreenFeign(){
        formula = this.formulaFeign;
    }

    /**
     * 
     * @param query
     * @param type  1文献  2指南 3说明书 4临床试验 5hta 6cde
     * @return
     */
    public static String formula(String query, Integer type) {
        JSONObject dataFormula = new JSONObject();
        dataFormula.put("query", query);
        dataFormula.put("type", type);
        dataFormula.put("other", 2);
        log.info("query is {}", query);
        try {
            return formula.retrieval(dataFormula);
        } catch (Exception e) {
            return "";
        }
    }
}
