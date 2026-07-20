package com.sentum.evidencecomprehensive.domain.vo.resp;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Transient;


/**
 *  hta 列表实体类
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class HtaReportResponse {

    private String id;
    /**
     * pdf标题
     */
    private String title;
    /**
     * 链接
     */
    private String link;
    /**
     * 来源-国家
     */
    private String source;
    /**
     * 
     */
    private String sourceFull;
    /**
     * pdfName
     */
    private String pdfName = "";
    /**
     * 
     */
    private String pdfNameUrl = "";
    /**
     * pdf链接-翻译版本连接
     */
    private String transPdfUrl = "";
    /**
     *发布时间
     */
    private Long publishTimeDateTs;
    /**
     * 发表时间
     */
    private String publishTime;
    /**
     * 0默认状态，1纳入状态，2排除状态
     */
    @Transient
    private Integer inclusion = 0;
    /**
     * 收藏标记，1-已收藏，0-未收藏
     */
    @Transient
    private Integer collect = 0;
}
