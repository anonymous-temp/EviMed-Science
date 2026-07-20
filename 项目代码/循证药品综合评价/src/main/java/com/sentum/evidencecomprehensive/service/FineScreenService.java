package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;

import java.util.List;

/**
 * Description:
 * DateTime: 2024/4/12
 */
public interface FineScreenService {

    /**
     * 通过用户输入的词获得联想词的操作
     *
     * @param word 用户输入的词
     * @return 返回联想词的list集合
     */
    List<String> getAssociationalWord(String word);

    /**
     * 文献翻译
     * @param id 文献id
     * @return 翻译结果
     */
    JSONObject transSummaryAndTitle(String id);
}
