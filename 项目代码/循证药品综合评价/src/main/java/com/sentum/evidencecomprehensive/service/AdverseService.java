package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.vo.req.SafeInfoRequest;

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
     * @param safeInfoRequest 检索信息
     * @return 适应症的集合
     */
    List<String> indication(SafeInfoRequest safeInfoRequest);

    /**
     * 计算药品安全性分析相关数据信息
     * @param safeInfoRequest 请求实体
     * @return 使用JSONObject返回算法存储mongo中定义的格式
     */
    JSONObject drugSafeInfo(SafeInfoRequest safeInfoRequest);
}
