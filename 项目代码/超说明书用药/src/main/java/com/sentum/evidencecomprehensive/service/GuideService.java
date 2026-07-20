package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.dto.GuideOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.GuideSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.GuideVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.req.GuideInitialRequest;

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
    JSONArray authorList(GuideInitialRequest guideInitialRequest);

    /**
     * 检索指南列表
     * @param guideSearchDto 检索条件
     * @param userId 用户id
     * @return 当前页的指南列表
     */
    PageVo<GuideVo> list(GuideSearchDto guideSearchDto, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param guideOperateDto 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(GuideOperateDto guideOperateDto, Long userId);

    /**
     * 展示用户收藏的指南列表数据
     * @param userId 用户id
     * @param searchWord 用户检索词
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @return 药品列表
     */
    PageVo<GuideVo> showGuideCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum);

    Map<String, String> includeLatest(String id, Long userId);
}
