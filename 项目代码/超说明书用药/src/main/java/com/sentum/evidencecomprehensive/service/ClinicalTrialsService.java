package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.pojo.bo.mongo.ClinicalTrialRegistration;
import com.sentum.evidencecomprehensive.pojo.dto.ClinicalTrialsOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.ClinicalTrialsSearchDto;
import com.sentum.evidencecomprehensive.pojo.dto.ThreeClinicalTrialsSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.ClinicalTrialsVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.ThreeClinicalTrialsVo;

import java.util.List;

public interface ClinicalTrialsService {
    /**
     * 检索临床试验列表
     * @param searchDto 检索条件
     * @param userId 用户id
     * @return 当前页的文献列表
     */
    PageVo<ClinicalTrialsVo> list(ClinicalTrialsSearchDto searchDto, Long userId);

    /**
     * 临床试验收藏/取消收藏
     * @param operateDto 批量操作
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(ClinicalTrialsOperateDto operateDto, Long userId);

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
    void defaultInclusion(String id, Long userId);

    /**
     * 增加的第三个检索临床试验列表
     * @param searchDto 查询条件
     * @return
     */
    PageVo<ThreeClinicalTrialsVo> threeList(ThreeClinicalTrialsSearchDto searchDto);

}
