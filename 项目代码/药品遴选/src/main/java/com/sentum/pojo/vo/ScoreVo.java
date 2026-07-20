package com.sentum.pojo.vo;

import com.alibaba.fastjson.JSONObject;
import io.swagger.models.auth.In;
import lombok.Data;

/**
 * 分数模型
 */
@Data
public class ScoreVo {
    //安全性
    private ScoreItemVo safe;
    //有效性
    private ScoreItemVo effective;
    //适宜性
    private ScoreItemVo suitability;
    //可及性
    private ScoreItemVo accessibility;
    //经济性
    private ScoreItemVo economy;
}
