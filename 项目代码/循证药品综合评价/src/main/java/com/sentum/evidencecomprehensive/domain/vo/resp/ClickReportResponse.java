package com.sentum.evidencecomprehensive.domain.vo.resp;

import com.sentum.evidencecomprehensive.domain.vo.PdfToPicVo;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("点选报告 后台下载列表")
public class ClickReportResponse implements Serializable {
    private static final long serialVersionUID=1L;
    
    private String id;
    
    private String title;
    
    private String reportCreate;
    
    private String status;
    
    private String modIng;
}
