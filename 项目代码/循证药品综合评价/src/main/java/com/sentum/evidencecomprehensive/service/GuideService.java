package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.vo.req.GuideInitialRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.GuideSearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.GuideResponse;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;

import javax.validation.Valid;
import java.util.List;
import java.util.Map;

/**
 * 指南页面相关逻辑
 * @author zgm
 */
public interface GuideService {
    /**
     * 获取当前检索条件的制定者列表
     *
     * @param guideInitialRequest
     * @return 制定者列表
     */
    JSONObject initial(GuideInitialRequest guideInitialRequest);

    /**
     * 检索指南列表
     * @param guideSearchRequest 检索条件
     * @param userId 用户id
     * @return 当前页的指南列表
     */
    PageVo<GuideResponse> list(GuideSearchRequest guideSearchRequest, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param OperateRequest 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(OperateRequest OperateRequest, Long userId);

    /**
     * 指南的默认纳入逻辑
     * @param id 检索id
     * @param userId 用户id
     * @return 成功true
     */
    Boolean defaultInclusion(String id, Long userId);

    /**
     * 展示用户收藏的指南列表数据
     * @param userId 用户id
     * @param searchWord 用户检索词
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @return 药品列表
     */
    PageVo<GuideResponse> showGuideCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum);

    /**
     * 根据药品和疾病获取指南中重要的信息数据
     * @param pdfTxt 指南原文
     * @param drugNames 药品名称及其同义词
     * @param diseases 疾病名称及其同义词
     * @return 获取到的指南的关键性信息
     */
    List<String> getMainGuideInfo(String pdfTxt, List<String> drugNames, List<String> diseases);

    /**
     * 指南的默认纳入
     * @param condition 课题
     * @param userId 用户 id
     */
    Boolean guidInclude(Condition condition, Long userId);

    /**
     * 二代指南的纳入规则 基于初筛结果
     * @param condition
     * @return
     */
    List<Map<String, String>> secondGenerationInclude(Condition condition);
}
