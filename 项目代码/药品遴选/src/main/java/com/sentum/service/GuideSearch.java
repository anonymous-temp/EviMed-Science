package com.sentum.service;

import cn.hutool.json.JSONObject;
import com.sentum.pojo.GuideAndScore;
import com.sentum.pojo.vo.TrGuideVo;

import java.util.List;

public interface GuideSearch {
    //西药检索
    GuideAndScore sdyPanel(String drugName, String disease, List<String> drugNames, List<String> diseases);


    GuideAndScore vaePanel(
            String drugName,
            String disease,
            List<String> drugNames,
            List<String> diseases,
            String scoringRules  // ✅ 打分规则作为参数传入
    );

    TrGuideVo getGuideWithCache(List<String> drugZhs, String drugZh);


}
