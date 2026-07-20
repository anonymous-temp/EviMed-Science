package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.mongo.ClinicalTrialRegistration;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.ClinicalTrialsResponse;
import com.sentum.evidencecomprehensive.domain.vo.req.ClinicalTrialsSearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.ThreeClinicalTrialsRequest;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.resp.ThreeClinicalTrialsResponse;

import java.util.List;

public interface ClinicalTrialsService {
    /**
     * 检索临床试验列表
     * @param searchDto 检索条件
     * @param userId 用户id
     * @param type 类型 1 默认，目前 2 是默认纳入
     * @return 当前页的文献列表
     */
    PageVo<ClinicalTrialsResponse> list(ClinicalTrialsSearchRequest searchDto, Long userId, int type);

    /**
     * 临床试验收藏/取消收藏
     * @param operateDto 批量操作
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(OperateRequest operateDto, Long userId);

    /**
     * 根据检索id检索临床试验相关信息 for 不良反应
     * @param id 检索id
     * @return 临床试验的全部信息
     */
    List<ClinicalTrialRegistration> getInfoForAdverse(String id);

    /**
     * 临床试验默认纳入逻辑
     * @param id 检索id
     * @param userId 用户id
     * @return 成功true
     */
    Boolean defaultInclusion(String id, Long userId);

    /**
     * 增加的第三个检索临床试验列表
     * @param searchDto 查询条件
     * @return
     */
    PageVo<ThreeClinicalTrialsResponse> threeList(ThreeClinicalTrialsRequest searchDto);
    
}
