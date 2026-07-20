package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.dto.SafeInfoDto;

import java.util.List;

/**
 * 不良反应相关API
 * @author zgm
 */
public interface AdverseService {
    /**
     * 检索不良反应相关数据
     * @param id 检索id
     * @return 相关信息数据
     */
    JSONObject info(String id);

    /**
     * 查询适应症
     * @param safeInfoDto 检索信息
     * @return 适应症的集合
     */
    List<JSONObject> indication(SafeInfoDto safeInfoDto);

    List<JSONObject> indicationJd(SafeInfoDto safeInfoDto);

    /**
     * 计算药品安全性分析相关数据信息
     * @param safeInfoDto 请求实体
     * @return 使用JSONObject返回算法存储mongo中定义的格式
     */
    JSONObject drugSafeInfo(SafeInfoDto safeInfoDto, Condition condition);



    JSONObject drugSafeInfoJd(SafeInfoDto safeInfoDto);

    
    JSONObject ptCount();
}
