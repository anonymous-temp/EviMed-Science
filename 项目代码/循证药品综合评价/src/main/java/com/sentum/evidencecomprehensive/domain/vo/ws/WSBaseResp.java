package com.sentum.evidencecomprehensive.domain.vo.ws;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * @Author: bcxsg
 * @Description: websocket相应参数
 */

@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class WSBaseResp<T> {

    /**
     * @see com.sentum.evidencecomprehensive.domain.enums.ws.WsResponseTypeEnum
     */
    private Integer type;
    
    private T data;
}
