package com.sentum.evidencecomprehensive.domain.vo.resp;

import io.swagger.annotations.ApiModel;
import lombok.Data;

/**
 * Description:
 */
@ApiModel("cde 查询实体类")
@Data
public class CdeResponse {
    private String id;
    /**
     * 受理号
     */
    private String acceptid;
    /**
     * 药品名称
     */
    private String drgnamecn;
    /**
     * 企业名称
     */
    private String companys;
    /**
     * 药品类型
     */
    private String drugtype;
    /**
     * 注册类型
     */
    private String registerkind;
    /**
     * pdfUrl1
     */
    private String pdfUrl1;
    private String date;
    /**
     * 0默认状态，1纳入状态，2排除状态
     */
    private Integer bringIntoOrExcludeMark = 0;
    /**
     * 收藏标记，1-已收藏，0-未收藏
     */
    private Integer collectionMark = 0;
}
