package com.sentum.evidencecomprehensive.pojo.vo.res;

import com.alibaba.fastjson.JSONArray;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;
import lombok.Getter;
import lombok.Setter;

@Setter
@Getter
public class AlgPdfModeVo {
    /**
     * 模块 id
     */
    private String modeId;
    private String title;
    /**
     * 标题悬停提示，只有 meta 有
     */
    private String titleTips;
    /**
     * 每个模块的解析内容
     */
    private JSONArray body;
    /**
     * 原因，小叹号
     */
    private String reason;
    /**
     * 质量评价结果
     */
    private String predict;
}
