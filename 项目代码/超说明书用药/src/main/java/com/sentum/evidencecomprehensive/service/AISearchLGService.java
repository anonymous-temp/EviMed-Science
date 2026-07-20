package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/28
 */
public interface AISearchLGService {

    JSONObject searchLG(String questionId);

    List<JSONObject> searchCB(List<String> needSearchDrugNames, List<String> diseases);

    List<String> aiSplitDisease(JSONObject json);

    void expandedWords(Condition condition);

    void deconWords(Condition condition);
}
