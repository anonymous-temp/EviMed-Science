package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.vo.req.CdeRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.CdeResponse;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;

/**
 * Description:
 */
public interface CdeService {

    PageVo<CdeResponse> list(CdeRequest cdeRequest, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param operateRequest 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(OperateRequest operateRequest, Long userId);

    
    PageVo<CdeResponse> collect(CdeRequest cdeRequest, long userId);

//    Boolean cdeInclude(Condition condition, long userId);
}
