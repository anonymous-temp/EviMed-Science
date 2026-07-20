package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;

import java.util.List;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/28
 */
public interface AiSearchLGService {

    List<String> aiSplitDisease(JSONObject json);

    void secondGenerationInclude(Condition condition, List<Map<String, String>> searchGuide, Map<String, String> guideTitleToText1, List<String> includeIds);

    List<String> searchBlock(String id, String language, List<String> drugSynonym, List<String> diseaseSynonym);
}
